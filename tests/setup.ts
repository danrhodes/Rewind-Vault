// Source code uses `window` timers for popout-window support; in Node tests it is the global object.
(globalThis as { window?: unknown }).window ??= globalThis;
