# Svar til bwp91 på homebridge#3958 — klar til at poste

```markdown
Thank you — this is exactly the kind of verification I was hoping for, and
the C → Q correction is a genuinely important update. You're right that my
analysis was written against the older changes-omitted reading of the
attribute; I've already corrected the plugin's documentation to reflect the
Matter 1.4 Q (quieter) quality and your subscription trace
(mathiashornbek/homebridge-roborock-matter@main, README + docs).

Your controller log also explains two things I had observed but couldn't
fully reconcile: the resync nudge's null → value transition "working" at the
wire level while Apple still never converged, and `batChargeState` updating
live throughout. Both are consistent with the reports leaving the bridge and
Apple simply not applying Q-quality percentage reports in steady state.

I'll run the verification you suggested on my production setup (three
robots: one V1, two B01) — Homebridge with matter.js debug logging through a
full charge cycle, watching for the subscription flushes carrying
`batPercentRemaining` — and post the log excerpts here. If I can get
chip-tool set up on the same network I'll add a subscription trace from that
side too.

Assuming both confirm what your trace already shows, I'll file the Apple
Feedback report about the controller's handling of Q-quality PowerSource
attributes and link it here so others can dupe it. Thanks again for digging
in — happy to test any builds if something changes in the Homebridge Matter
layer down the road.
```
