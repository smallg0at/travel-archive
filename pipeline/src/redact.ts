import type { PhotoRecord, PhotoShard } from "@travel-archive/shared";
import { ArchiveBusyError, releaseLockOnExit, withArchiveLock } from "./lock.js";
import { getAccessToken } from "./auth.js";
import { loadIndex, loadShard, saveShard } from "./archiveStore.js";
import { detectSensitive, flagFor, loadRedactionTerms, withheldFromSummaries } from "./sensitive.js";
import { mayBeAnalyzed } from "./screenshots.js";

/**
 * Scans transcribed photo text for personal identifiers and flags what it
 * finds, so `organize` keeps those photos out of day summaries.
 *
 *   npm run --workspace pipeline redact                      # report only
 *   npm run --workspace pipeline redact -- --apply
 *   npm run --workspace pipeline redact -- --apply --month 2025-04
 *   npm run --workspace pipeline redact -- --dismiss <photoId>
 *   npm run --workspace pipeline redact -- --revoke --apply
 *
 * Report-only by default. Detection is regex-based and will produce false
 * positives, so the first thing it does is show you what it found; nothing is
 * written until you ask. Re-running after `analyze` is the intended habit —
 * only photos that have been transcribed can be flagged, and `analyze` is what
 * produces the transcripts.
 *
 * `--dismiss` releases one photo you have reviewed and judged harmless. The
 * flag stays on the record marked dismissed rather than being deleted, so a
 * later run does not simply re-raise it.
 *
 * `--revoke` closes a gap in the allowlist. Removing an app from
 * screenshot-apps.json stops *future* sends, but says nothing about screenshots
 * from that app which were already described — their captions and transcripts
 * stay in the archive and keep feeding summaries. This finds every photo that
 * may no longer be analyzed yet still carries stored analysis, and clears those
 * fields. It deletes model output, so it never runs by default and never
 * without --apply.
 */

interface Options {
  apply: boolean;
  month: string | null;
  dismiss: string | null;
  revoke: boolean;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const valueOf = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
  };
  return {
    apply: args.includes("--apply"),
    month: valueOf("--month"),
    dismiss: valueOf("--dismiss"),
    revoke: args.includes("--revoke"),
  };
}

function describe(photo: PhotoRecord): string {
  const when = photo.takenAt?.slice(0, 10) ?? "undated";
  return `${when}  ${photo.fileName}`;
}

async function dismissOne(token: string, months: string[], photoId: string): Promise<boolean> {
  for (const month of months) {
    const shard = await loadShard(token, month);
    const photo = shard.photos[photoId];
    if (!photo?.sensitive) continue;

    photo.sensitive = { ...photo.sensitive, dismissed: true };
    await saveShard(token, shard);
    console.log(`Dismissed ${describe(photo)} — it will be summarized normally from now on.`);
    return true;
  }
  return false;
}

/** Strips stored model output from photos the allowlist no longer permits. */
async function revokeDisallowed(token: string, months: string[], apply: boolean): Promise<void> {
  let found = 0;
  const changed: PhotoShard[] = [];

  for (const month of months) {
    const shard = await loadShard(token, month);
    let dirty = false;

    for (const photo of Object.values(shard.photos)) {
      if (mayBeAnalyzed(photo) || !photo.analyzedAt) continue;
      found++;
      console.log(`${describe(photo)}`);
      console.log(`  app     ${photo.screenshot?.sourceApp ?? "(none in filename)"}`);
      console.log(`  caption ${photo.caption ?? "(none)"}`);
      console.log(`  text    ${photo.extractedText ? `${photo.extractedText.length} chars transcribed` : "none"}`);
      console.log("");

      if (apply) {
        photo.analyzedAt = null;
        photo.contentType = null;
        photo.caption = null;
        photo.tags = [];
        photo.extractedText = null;
        photo.notable = false;
        photo.quality = null;
        photo.visibility = null;
        dirty = true;
      }
    }
    if (dirty) changed.push(shard);
  }

  if (found === 0) {
    console.log("No stored analysis belongs to a disallowed app. Nothing to revoke.");
    return;
  }
  if (!apply) {
    console.log(`${found} photo(s) carry analysis their app is no longer allowed. Re-run with --apply to clear it.`);
    return;
  }
  for (const shard of changed) await saveShard(token, shard);
  console.log(`Revoked ${found} photo(s) across ${changed.length} shard(s). Re-run \`organize\` to drop them from summaries.`);
}

async function runMain() {
  const opts = parseArgs();

  console.log("Signing in...");
  const token = await getAccessToken();
  const index = await loadIndex(token);
  const months = index.months.map((m) => m.month).filter((m) => !opts.month || m.startsWith(opts.month));

  if (opts.dismiss) {
    const found = await dismissOne(token, months, opts.dismiss);
    if (!found) console.log(`No flagged photo with id ${opts.dismiss}.`);
    return;
  }

  if (opts.revoke) {
    await revokeDisallowed(token, months, opts.apply);
    return;
  }

  const terms = await loadRedactionTerms();
  console.log(
    terms.length > 0
      ? `Loaded ${terms.length} personal term(s) from pipeline/redaction-terms.json.`
      : "No personal terms configured — add your name to pipeline/redaction-terms.json so it can be caught.",
  );
  console.log(`Checking ${months.length} month(s)...\n`);

  let transcribed = 0;
  let flagged = 0;
  let alreadyDismissed = 0;
  const noticed: string[] = [];
  const changedShards: PhotoShard[] = [];

  for (const month of months) {
    const shard = await loadShard(token, month);
    let changed = false;

    for (const photo of Object.values(shard.photos)) {
      if (!photo.extractedText) continue;
      transcribed++;

      const detection = detectSensitive(photo.extractedText, terms);
      if (!detection) continue;

      // Contact details alone don't withhold anything — see NOTICE_ONLY in
      // sensitive.ts. List them so the user can spot a real one and add it to
      // redaction-terms.json, then move on.
      if (detection.kinds.length === 0) {
        noticed.push(`${describe(photo)}
  seen    ${detection.notices.join("  |  ")}`);
        continue;
      }

      if (photo.sensitive?.dismissed) {
        alreadyDismissed++;
        continue;
      }

      flagged++;
      const flag = flagFor(detection, photo.sensitive);
      console.log(`${describe(photo)}`);
      console.log(`  id      ${photo.id}`);
      console.log(`  kinds   ${flag.kinds.join(", ")}`);
      console.log(`  matched ${flag.samples.join("  |  ")}`);
      console.log("");

      if (opts.apply) {
        photo.sensitive = flag;
        changed = true;
      }
    }

    if (changed) changedShards.push(shard);
  }

  if (noticed.length > 0) {
    console.log(`Contact details seen on ${noticed.length} photo(s) — not withheld, listed for review:
`);
    for (const line of noticed) console.log(`${line}
`);
  }

  console.log(`${transcribed} photo(s) carry transcribed text; ${flagged} flagged, ${alreadyDismissed} previously dismissed.`);

  if (!opts.apply) {
    console.log(
      flagged > 0
        ? "\nReport only — nothing written. Re-run with --apply to withhold these from summaries."
        : "\nNothing to flag.",
    );
    return;
  }

  for (const shard of changedShards) await saveShard(token, shard);
  console.log(`Wrote ${changedShards.length} shard(s).`);

  const stillWithheld = changedShards.flatMap((s) => Object.values(s.photos)).filter(withheldFromSummaries).length;
  console.log(`${stillWithheld} photo(s) are now withheld from day summaries. Re-run \`organize\` to apply.`);
}

/**
 * Refuses to start while another writer holds the archive — see lock.ts.
 * The whole command is one critical section: an interrupted half-write is
 * the failure this exists to prevent.
 */
async function main() {
  releaseLockOnExit();
  await withArchiveLock("redact (CLI)", runMain);
}

main().catch((err) => {
  // A busy archive is an expected outcome, not a crash: print the reason,
  // not a stack trace the user has to read past.
  if (err instanceof ArchiveBusyError) {
    console.error(`
${err.message}
`);
    process.exit(2);
  }
  console.error(err);
  process.exit(1);
});
