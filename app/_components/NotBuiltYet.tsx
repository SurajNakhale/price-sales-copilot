import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * A page for a feature that has not been written yet. It says what will be
 * here and which feature it belongs to, rather than showing placeholder data
 * that looks real.
 */
export function NotBuiltYet({
  feature,
  title,
  children,
  steps,
}: {
  feature: string;
  title: string;
  children: React.ReactNode;
  steps?: string[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription className="text-[11px] font-medium tracking-wide uppercase">
          {feature} · not built yet
        </CardDescription>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="max-w-2xl text-sm text-ink-2">{children}</div>
        {steps ? (
          <ol className="max-w-2xl space-y-1.5 text-sm text-muted-foreground">
            {steps.map((step, index) => (
              <li key={step} className="flex gap-2.5">
                <span className="tabular-nums">{index + 1}.</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </CardContent>
    </Card>
  );
}
