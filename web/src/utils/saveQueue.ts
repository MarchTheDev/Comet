export type SaveState = "saved" | "unsaved" | "saving" | "error";

type Snapshot = { path: string; content: string; revision: number };

/**
 * Debounce edits, serialize writes, and keep the latest failed edit for retry.
 * A note switch or window close can await flushAll() before proceeding.
 */
export class SaveQueue {
  private pending: Snapshot | null = null;
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly write: (path: string, content: string) => Promise<void>,
    private readonly onState: (state: SaveState) => void,
    private readonly onFailure: (error: unknown) => void,
    private readonly delay = 450,
  ) {}

  queue(path: string, content: string) {
    this.pending = { path, content, revision: ++this.revision };
    this.onState("unsaved");
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(this.onFailure);
    }, this.delay);
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const snapshot = this.pending;
    if (!snapshot) {
      const current = this.chain;
      try {
        await current;
      } catch (error) {
        // A newer edit/write can supersede a failed in-flight write.
        if (!this.pending && current === this.chain) throw error;
      }
      return;
    }

    this.pending = null;
    this.onState("saving");
    const operation = this.chain.catch(() => undefined).then(() => this.write(snapshot.path, snapshot.content));
    this.chain = operation;
    try {
      await operation;
      if (!this.pending && this.chain === operation) this.onState("saved");
    } catch (error) {
      // Never restore an old snapshot over a newer edit or a queued write.
      if (snapshot.revision !== this.revision) return;
      if (!this.pending) this.pending = snapshot;
      this.onState("error");
      throw error;
    }
  }

  async flushAll(): Promise<void> {
    for (;;) {
      await this.flush();
      const current = this.chain;
      try {
        await current;
      } catch (error) {
        if (this.pending || current !== this.chain) continue;
        throw error;
      }
      if (!this.pending && current === this.chain) return;
    }
  }
}
