import "server-only";
import type { ChatStreamEvent } from "@/types/api";

/**
 * Encodes events as newline-delimited JSON. Pull-based, so a slow client
 * applies backpressure, and cancelling the response stops the generator
 * (which in turn aborts the upstream provider request).
 *
 * `onCancel` runs after the generator stops. A generator that never started
 * does not run its `finally`, so cleanup that must always happen goes here too.
 */
export function toNdjsonStream(
  events: AsyncGenerator<ChatStreamEvent>,
  onCancel?: () => Promise<void>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const encode = (event: ChatStreamEvent) => encoder.encode(`${JSON.stringify(event)}\n`);

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await events.next();
        if (done) controller.close();
        else controller.enqueue(encode(value));
      } catch {
        // streamChatTurn reports its own failures; this is a last resort.
        controller.enqueue(
          encode({
            type: "error",
            code: "internal_error",
            message: "Something went wrong. Please retry.",
            retryable: true,
          }),
        );
        controller.close();
      }
    },
    async cancel() {
      await events.return(undefined);
      await onCancel?.();
    },
  });
}
