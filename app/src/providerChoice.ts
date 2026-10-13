/**
 * One place that knows what a model service is.
 *
 * Two screens choose a model: Settings' Generation table (the archive's model,
 * every service) and the Generate panel's screenshot tab (a service on this
 * machine, and nothing else). The rules that matter — a local service needs no
 * key, a cloud one does; a check reports and never gates — and the wording that
 * says so must live once, or the same service gets two different stories
 * depending on where the reader looks.
 */
import type { ProviderOption } from "@travel-archive/shared";
import { ui } from "./i18n";
import { validateGeneration } from "./backend";

/** A provider's name in the reader's language; keyed by the stable preset id. */
export function providerName(option: ProviderOption): string {
  return (ui.settings.providers as Record<string, string>)[option.id] ?? option.label;
}

/** Whether a service can be used as it stands, and how to say it without lying. */
export function keyState(option: ProviderOption): { text: string; warn: boolean } {
  if (option.hasKey) return { text: ui.settings.providerKeySet, warn: false };
  // A local service is ready without a key: saying "no key" about LM Studio is
  // the same lie as asking it for one.
  if (option.scope === "local") return { text: ui.settings.providerLocalNoKey, warn: false };
  return { text: ui.settings.providerKeyMissing, warn: true };
}

/** Whether this service would work right now, key or no key. */
export function usableAsIs(option: ProviderOption | undefined): boolean {
  return !!option && (option.hasKey || option.scope === "local");
}

/** The services that run on this machine — the only ones a local pass may use. */
export function localOptions(providers: ProviderOption[]): ProviderOption[] {
  return providers.filter((p) => p.scope === "local");
}

/**
 * Ask a service whether it answers, as one line ready to show. Never a gate: a
 * service that happens to be down should still be saveable.
 */
export async function checkProvider(id: string, typedKey?: string): Promise<{ text: string; warn: boolean }> {
  const result = await validateGeneration(id, typedKey);
  if (result.ok) return { text: ui.settings.providerCheckOk, warn: false };
  if (result.kind === "auth") return { text: ui.setup.keyRejected(result.detail), warn: true };
  return { text: ui.settings.providerCheckUnreachable(result.detail), warn: true };
}
