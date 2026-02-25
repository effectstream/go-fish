type AnimationTask = () => Promise<void>;

/**
 * Queues animation tasks and plays them sequentially.
 * Prevents visual chaos when multiple state changes arrive from polling.
 */
export class AnimationQueue {
  private queue: AnimationTask[] = [];
  private isPlaying = false;

  /** Add an animation task to the queue. It will run after all previously queued tasks. */
  enqueue(task: AnimationTask): void {
    this.queue.push(task);
    this.processNext();
  }

  /** Check if the queue is currently playing an animation. */
  get busy(): boolean {
    return this.isPlaying;
  }

  /** Number of tasks waiting (including currently playing). */
  get pending(): number {
    return this.queue.length + (this.isPlaying ? 1 : 0);
  }

  private async processNext(): Promise<void> {
    if (this.isPlaying || this.queue.length === 0) return;

    this.isPlaying = true;
    const task = this.queue.shift()!;

    try {
      await task();
    } catch (err) {
      console.warn('[AnimationQueue] Task failed:', err);
    }

    this.isPlaying = false;
    this.processNext();
  }

  /** Clear all pending tasks (does not cancel the currently playing one). */
  clear(): void {
    this.queue = [];
  }
}
