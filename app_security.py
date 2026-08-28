# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
"""Small, dependency-free security helpers for the Flask application."""

import collections
import threading
import time
from typing import Deque, Dict, Optional


class SlidingWindowRateLimiter:
  """Per-key sliding-window limiter suitable for endpoint abuse protection.

  This is intentionally an application-instance backstop. Production edge
  rate limiting remains recommended, but a missing edge rule no longer leaves
  the signed-URL endpoint completely unbounded.
  """

  def __init__(self, limit: int, window_seconds: int):
    if limit <= 0 or window_seconds <= 0:
      raise ValueError('Rate limit and window must be positive')
    self._limit = limit
    self._window_seconds = window_seconds
    self._events: Dict[str, Deque[float]] = {}
    self._lock = threading.Lock()

  def check(self, key: str, now: Optional[float] = None) -> int:
    """Consumes one request and returns Retry-After seconds, or zero."""
    timestamp = time.monotonic() if now is None else now
    cutoff = timestamp - self._window_seconds
    with self._lock:
      events = self._events.setdefault(key, collections.deque())
      while events and events[0] <= cutoff:
        events.popleft()
      if len(events) >= self._limit:
        return max(1, int(events[0] + self._window_seconds - timestamp + 0.999))
      events.append(timestamp)
      return 0

  def clear(self) -> None:
    """Clears process-local counters; used by deterministic tests."""
    with self._lock:
      self._events.clear()
