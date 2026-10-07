/** Give the event loop a turn so rendering and input can run. */
export function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Returns a function to call inside long loops. It only yields once `budgetMs` has
 * passed since the last yield, keeping each uninterrupted slice of work short
 * (PLAN §11: UI never blocked more than 50 ms per chunk).
 */
export function createYielder(
  budgetMs = 30,
  now: () => number = () => Date.now(),
  yieldFn: () => Promise<void> = yieldToUI,
): () => Promise<void> {
  let last = now();
  return async () => {
    if (now() - last < budgetMs) return;
    await yieldFn();
    last = now();
  };
}
