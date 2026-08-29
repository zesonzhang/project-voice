/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export interface DownloadProgressMessage {
  type: 'DOWNLOAD_PROGRESS';
  modelId: string;
  version: string;
  bytesDownloaded: number;
  totalBytes: number;
  speedBps: number;
  percentage: number;
}

export interface StateChangeMessage {
  type: 'STATE_CHANGE';
  modelId: string;
  version: string;
  state: string;
  error?: string;
}

export type LifecycleBroadcastMessage =
  | DownloadProgressMessage
  | StateChangeMessage;

export interface TabCoordinator {
  acquireDownloadLock<T>(
    modelId: string,
    version: string,
    action: () => Promise<T>,
    onLockContended?: () => void,
  ): Promise<T>;
  broadcastProgress(progress: DownloadProgressMessage): void;
  broadcastStateChange(change: StateChangeMessage): void;
  onMessage(listener: (msg: LifecycleBroadcastMessage) => void): () => void;
  close(): void;
}

const BROADCAST_CHANNEL_NAME = 'project-voice-model-lifecycle';

/**
 * Coordinates model download concurrency and lifecycle events across browser tabs.
 */
export class BrowserTabCoordinator implements TabCoordinator {
  private channel: BroadcastChannel | null = null;
  private listeners: Set<(msg: LifecycleBroadcastMessage) => void> = new Set();

  constructor() {
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
        this.channel.onmessage = event => {
          const msg = event.data as LifecycleBroadcastMessage;
          for (const listener of this.listeners) {
            try {
              listener(msg);
            } catch (err) {
              console.error('Error in tab coordinator listener:', err);
            }
          }
        };
      } catch (err) {
        console.warn('BroadcastChannel not available:', err);
      }
    }
  }

  async acquireDownloadLock<T>(
    modelId: string,
    version: string,
    action: () => Promise<T>,
    onLockContended?: () => void,
  ): Promise<T> {
    const lockName = `model-download:${modelId}:${version}`;

    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      type LockAttempt = {acquired: false} | {acquired: true; value: T};
      const attempt = await navigator.locks.request(
        lockName,
        {ifAvailable: true},
        async lock => {
          if (!lock) return {acquired: false} as LockAttempt;
          return {acquired: true, value: await action()} as LockAttempt;
        },
      );
      if (attempt.acquired) return attempt.value;

      onLockContended?.();
      // Let rejections from the queued request propagate to the caller. The
      // previous nested-Promise implementation swallowed this rejection and
      // left downloadModel() pending forever.
      return await navigator.locks.request(lockName, async lock => {
        if (!lock) throw new Error(`Failed to acquire Web Lock: ${lockName}`);
        return await action();
      });
    }

    // Fallback: run action directly if Web Locks API is unavailable
    return await action();
  }

  broadcastProgress(progress: DownloadProgressMessage): void {
    if (this.channel) {
      try {
        this.channel.postMessage(progress);
      } catch {
        // Ignored if channel closed
      }
    }
  }

  broadcastStateChange(change: StateChangeMessage): void {
    if (this.channel) {
      try {
        this.channel.postMessage(change);
      } catch {
        // Ignored if channel closed
      }
    }
  }

  onMessage(listener: (msg: LifecycleBroadcastMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
    this.listeners.clear();
  }
}
