"use client";

import { partOfDay } from "@/lib/greeting";
import { useNow } from "./LocalTime";

/**
 * "Good morning, Sam". The server cannot know the visitor's time zone, so it
 * renders "Hello" and the browser swaps in the right part of the day.
 */
export function Greeting({ name }: { name: string | null }) {
  const now = useNow();
  const hello = now === null ? "Hello" : `Good ${partOfDay(new Date(now).getHours())}`;
  return (
    <>
      {hello}
      {name ? `, ${name}` : ""}
    </>
  );
}
