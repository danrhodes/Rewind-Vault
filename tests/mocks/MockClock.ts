/** Deterministic clock. Time only moves when the test advances it. */
export class MockClock {
  private current: number;

  constructor(startMs = Date.UTC(2026, 9, 7, 21, 24, 0)) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(ms: number): void {
    this.current = ms;
  }
}
