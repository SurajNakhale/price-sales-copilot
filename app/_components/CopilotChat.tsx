"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Sparkles } from "lucide-react";

import { CopilotAnswer } from "@/app/_components/CopilotAnswer";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  COPILOT_HISTORY_PAIRS,
  COPILOT_MAX_QUESTION_LENGTH,
  type CopilotAnswer as Answer,
} from "@/lib/copilot/types";
import { historyText } from "@/lib/copilot/wording";
import type { ApiError } from "@/lib/types";

interface Entry {
  id: number;
  question: string;
  answer?: Answer;
  error?: string;
}

/**
 * The Sales Copilot thread. Each question goes to POST /api/copilot/ask with the
 * last few answered pairs, so a follow-up like "and Seagate?" can be resolved.
 * Nothing is stored: reloading the page starts a new thread.
 */
export function CopilotChat({ suggestions, configured }: { suggestions: string[]; configured: boolean }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const nextId = useRef(1);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries.length, pending]);

  async function ask(text: string) {
    const question = text.trim();
    if (!question || pending) return;

    const id = nextId.current++;
    const history = entries
      .filter((entry) => entry.answer)
      .slice(-COPILOT_HISTORY_PAIRS)
      .map((entry) => ({ question: entry.question, answer: historyText(entry.answer!) }));

    setEntries((current) => [...current, { id, question }]);
    setDraft("");
    setPending(true);

    const update = (patch: Partial<Entry>) =>
      setEntries((current) => current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));

    try {
      const response = await fetch("/api/copilot/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as ApiError | null;
        update({ error: body?.message ?? `The request failed (${response.status}).` });
        return;
      }
      update({ answer: (await response.json()) as Answer });
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col">
      <div className="flex-1 space-y-6 p-7 pb-4">
        {!configured ? (
          <Alert>
            <AlertTitle>Gemini is not set up</AlertTitle>
            <AlertDescription>
              Add GEMINI_API_KEY to .env.local and restart the app. The copilot needs Gemini to understand
              questions; it does not need Gmail.
            </AlertDescription>
          </Alert>
        ) : null}

        <section className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {entries.length === 0
              ? "Ask about sales, products, dealers or states. Every answer shows how it was worked out."
              : "Try another:"}
          </p>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((suggestion) => (
              <Button
                key={suggestion}
                variant="outline"
                size="sm"
                className="h-auto py-1.5 text-left font-normal whitespace-normal"
                disabled={pending || !configured}
                onClick={() => ask(suggestion)}
              >
                {suggestion}
              </Button>
            ))}
          </div>
        </section>

        {entries.map((entry) => (
          <article key={entry.id} className="space-y-3">
            <div className="flex justify-end">
              <p className="max-w-[75%] rounded-lg bg-primary px-3.5 py-2 text-sm text-primary-foreground">
                {entry.question}
              </p>
            </div>
            {entry.answer ? (
              <CopilotAnswer answer={entry.answer} onAsk={ask} disabled={pending || !configured} />
            ) : entry.error ? (
              <Alert variant="destructive">
                <AlertTitle>No answer</AlertTitle>
                <AlertDescription>
                  <p>{entry.error}</p>
                  <Button variant="outline" size="sm" className="mt-2" disabled={pending} onClick={() => ask(entry.question)}>
                    Ask again
                  </Button>
                </AlertDescription>
              </Alert>
            ) : (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <Sparkles className="size-4 animate-pulse" aria-hidden />
                Working out the steps…
              </p>
            )}
          </article>
        ))}
        <div ref={bottom} />
      </div>

      <form
        className="sticky bottom-0 border-t bg-background/95 px-7 py-3 backdrop-blur"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(draft);
        }}
      >
        <div className="flex items-center gap-2">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={COPILOT_MAX_QUESTION_LENGTH}
            placeholder="Ask about sales, products or dealers…"
            aria-label="Your question"
            disabled={!configured}
            className="h-10"
          />
          <Button type="submit" size="icon" className="size-10" disabled={pending || !draft.trim() || !configured}>
            <ArrowUp />
            <span className="sr-only">Ask</span>
          </Button>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Your question and the query results go to Gemini to choose the queries and word the answer. Dealer email
          addresses and the raw files never do.
        </p>
      </form>
    </div>
  );
}
