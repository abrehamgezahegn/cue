# Contributing to Cue

Thanks for looking. Bug reports, fixes and new ideas are all welcome.

## Before you start

Read [`AGENTS.md`](AGENTS.md). It records why the code works the way it does, and most of its
rules exist because something broke without them. If a change would undo one of them, open an
issue first and say why.

A few of those rules are firm:

- Every citation comes from a transcript segment that was sent to the model. Timestamps and quoted
  text are looked up from the transcript, never taken from model output.
- The API key stays in the local service. The browser only ever holds the `.cue-token`.
- A quiz is never padded with questions the transcript can't back, and there is no button that
  turns a wrong answer into a right one.
- The UI has no taglines or filler labels. A label either tells the reader something or it goes.

## Making a change

1. Fork the repository and create a branch.
2. Follow the setup in the [README](README.md).
3. Make your change. Rebuild after editing `src/`, and restart the service after editing `server/`.
4. Run the checks:

   ```bash
   npm run check
   ```

   ```bash
   npm test
   ```

   ```bash
   npm run qa:preview
   ```

   If you touched the content scripts, transcript fetching or seeking, also run
   `npm run qa:extension`. It drives real YouTube through Chrome for Testing; see "Testing gotchas"
   in `AGENTS.md` for the setup.
5. Try the change in a browser, not only in the type checker.
6. Open a pull request that says what changed, why, and how you checked it. Include a screenshot
   for anything visible.

If a change alters what the panel looks like, run `npm run screenshots` and commit the updated
images in `docs/screenshots/`.

## Reporting a bug

Include the video URL (or its length and whether it has auto-generated captions), the model you
used, what you expected, and what happened. Logs from the terminal running `npm start` help a lot.
Never paste the contents of `.env.local` or `.cue-token`.

## Files that must never be committed

`.env.local`, `.cue-token`, `bin/`, `.cache/`, `work/` and `outputs/extension/` are gitignored.
Keep them that way.
