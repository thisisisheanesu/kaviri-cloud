# Launch plan

A working document. Nothing in it is published copy until the pre-flight list in section 7
is clear. Every claim here is one the repository can evidence today, and the places where
it cannot are marked.

The position, which every item below serves: **your demo video is a build artifact**. It
changes when your product does, or the build fails. Nobody owns that sentence yet. Screen
Studio, Loom, Arcade, Supademo, Tella and Storylane all assume a person performs the demo.
Playwright records video and produces raw footage with no framing. The zoom is what makes
the output watchable. The CI failure is what makes it a category.

---

## 1. The sequence

### The decision

**Ship the open source recorder alone. Do not mention a hosted service beyond one line
saying one is being built.** The README already says exactly that and it is the right
posture.

### Why

The recorder is finishable evidence. It has 32 tests, CI is green, and an audit found 86
defects of which the 15 ship-blockers are fixed. It runs locally with no account and makes
no network call. Anyone who doubts a claim can clone it and check in thirty seconds. That
is a launch that survives contact with Hacker News.

The hosted service is not evidence of anything yet. Its SQL has never been applied to a
real Postgres. No job has gone from `submit_job` to a downloadable MP4 on a real
deployment. Launching a service in that state means the first person who tries it finds
out before you do, in public, in a comment thread, on the day.

There is also no price. The pricing recommendation is sound and the arithmetic holds, but
it closes by saying no price ships until a real job renders, and that is correct. A price
on a page is a promise to serve.

### What each choice costs

**Launching the recorder first costs you the monetisation narrative on day one.** You give
up the clean "here is the product and here is what it costs" story, and you give up
capturing the peak of attention as paid signups. Some fraction of the launch-day traffic
that would have converted will not come back. That fraction is small and unknowable, and
against it you get the thing that matters more at this stage: a free tool with no signup
spreads further than a free tier with one.

**Holding for both costs you months and risks the position.** "Demo video as a build
artifact" is currently unclaimed. It is not defensible by code. It is defensible by being
the thing people say when they describe the idea. Every week held is a week in which
someone else ships a worse version of the same sentence and gets it first. Holding also
means the hosted service gets built against zero demand signal, which is how a hosted
service that nobody wanted ends up with six months in it.

**The hidden cost of shipping first, and how to pay it:** the hosted service must not
look like it is sitting there working. One line in the README, a domain that resolves to a
page saying it is not live and an email field, nothing more. A landing page with tier
cards and a "Sign up" button, for a service whose SQL has never run, is the single most
expensive mistake available here, because it converts a credibility launch into a vapour
launch in one screenshot.

### The order

1. **Recorder, Apache 2.0, public repo.** Recorder, GitHub Action, docs, examples.
2. **The Action on the GitHub Actions marketplace**, the same day, because that listing is
   the distribution channel that keeps working after the launch traffic is gone.
3. **The Supabase asset** (section 2), filmed and published before any ask.
4. **Show HN** (section 3).
5. **Hosted service, only after the gate in section 5 is met**, which is three unprompted
   "can you host this for us" enquiries. Not two. Not one enthusiastic one.

`kaviri-cloud` stays private until then. It is FSL 1.1 and it currently contains
`docs/PRICING.md`, which the repository's own README says it does not contain. That file
moves to `kaviri-billing` before the repo goes public, as the pricing document itself
flags in its second paragraph.

---

## 2. The Supabase pitch

This is the highest value single item in this document. Treat it as such and do not rush
it to fit the launch date.

### What Supabase actually wants

Not a favour, and not a nice project. Supabase wants artefacts that make Supabase look
like the obvious choice for a certain kind of builder. Specifically:

- **Projects built on Supabase that are themselves good**, because the showcase is a proof
  that serious people pick it.
- **Technical writing they did not have to commission.** Their blog runs deep posts about
  Postgres, RLS and the internals. A post that teaches something real about their product
  is worth more to them than a post about yours.
- **Launch Week filler that is not their own launch.** Launch Weeks are a fixed cadence of
  content and the community and showcase slots need feeding.
- **Open source, unambiguously.** Apache 2.0 with no revenue threshold and no CLA is
  exactly the shape they can point at without qualification. This is the single reason the
  licence decision was right, and it should be said in the email in one clause.

What they do not want: a pitch. A request for a retweet. A hosted product with no users
asking for a logo placement.

### The asset, which ships before the ask

**A video of kaviri filming the Supabase dashboard, made by kaviri.**

This is the whole pitch. It is a thing they can watch in twenty seconds that demonstrates
the tool, flatters their product, and proves the tool works on a real application rather
than a toy page. No email can do that work.

Build it like this:

- Script it against a real Supabase project you own: log in, open the table editor, run a
  query in the SQL editor, open the RLS policy editor. Those are the surfaces Supabase
  themselves film.
- Film it in the `readme` preset and again in `tiktok`, because the vertical one is what a
  developer advocate can post without re-editing.
- Put the script in a public repo, in CI, with the failing-take gates on. The artefact is
  not just the video. The artefact is a repository where the Supabase dashboard demo
  re-records itself and the build goes red if it filmed nothing.
- Do not use credentials that matter. The telemetry sidecar carries every `navigate` URL
  verbatim, including query strings and tokens, so leave telemetry off and check the video
  frame by frame for a visible key before anything goes out.

**Publish it first, with no ask attached.** A tweet or a short post: here is kaviri filming
the Supabase dashboard, here is the repo, here is the CI run. Then let it sit for a few
days. If it gets any traction at all, the email below stops being cold.

### Who to send it to

Not `hello@`. Not a form. A named developer advocate.

Find them by opening the two or three most recent Supabase blog posts tagged community,
showcase or Launch Week and taking the bylines. Those are the people whose job is exactly
this and who have the standing to put something in a Launch Week slot. Cross-check on the
Supabase Discord, where the same people answer in public. Send to one person. Copy nobody.
A pitch sent to three advocates at once reads as a mail merge and each one assumes another
will handle it.

### When to send it

**Two to three weeks after the Show HN, and never during a Launch Week.**

Reasoning. Before the launch you have nothing to point at, so the email is a request.
After the launch you have a public repo, a star count, a Hacker News thread and comments
from real developers, so the email is a report. That is a different email entirely and it
is the only version worth sending.

Not during a Launch Week because everyone there is shipping fourteen hour days and an
inbound pitch is noise. The week after one closes is the best window: the content calendar
is empty and the next one is far enough away to plan for.

If the Show HN goes badly, send it anyway, three weeks later, with the video and without
the numbers. The video is the asset. The thread was only ever going to be a footnote.

### The email

Subject: **kaviri films your dashboard, in CI, and fails the build if it filmed nothing**

> Hi [name],
>
> I built a thing on Supabase and I filmed your dashboard with it. Two minutes, no ask in
> this paragraph: [link to the video].
>
> kaviri is a Rust CLI that records a web app from a JSON script and renders an MP4 with
> Screen Studio style zooms. It is built for agents rather than people, so the camera
> follows the text caret instead of a mouse pointer, and the demo video becomes a build
> artifact: a GitHub Action re-records it on every push and fails the build when the take
> filmed nothing, which it proves by comparing the first frame to the last with ffmpeg
> psnr. Apache 2.0, unconditional, no CLA, no revenue threshold.
>
> That video is recorded by the repo at [link], in CI, on a schedule. If Supabase changes
> the table editor, the video changes. If the dashboard fails to load, the job goes red.
>
> The hosted version I am building runs on Supabase: auth, Postgres with RLS for tenant
> isolation, and the job ledger. It is built and not yet live, so I am not pitching you a
> product.
>
> Two things I would value, either, neither, whichever fits:
>
> 1. The OSS showcase, if it qualifies.
> 2. A technical post on the RLS design for the job ledger, if that is interesting to you.
>    Multi-tenant queue leasing under RLS has some genuinely awkward corners and I have
>    written most of it down already.
>
> If the answer to both is no, the video is yours to use regardless. No attribution needed.
>
> Isheanesu

Why this email works, briefly, so it does not get "improved" into a worse one. It leads
with the gift and the gift is about them. It states the licence in one clause because that
is the thing that decides whether they can feature it at all. It names two asks, both
cheap, both things they already do, ranked. It gives away the video unconditionally, which
removes the transaction. It is short enough to read on a phone.

**Do not** attach a deck. **Do not** mention pricing. **Do not** say the hosted service is
running, because it is not, and one sentence of that would cost the whole relationship.

### The second, better ask, held in reserve

If the first email lands, the one worth making later is that **Supabase use kaviri for
their own Launch Week demo videos**. They ship a dozen features a week and each one needs
a clip. That is a real workload, it is the strongest possible reference, and it is also
the fastest way to find out what the tool cannot yet do. Do not ask for it first. Ask for
it once they have already said yes to something.

---

## 3. Show HN

### The title

    Show HN: kaviri – records your app in CI and fails the build if the take filmed nothing

Why this one. The title carries the whole differentiator and it is the half nobody else
has. It does not say "Screen Studio for AI agents", because a title that positions against
a Mac app invites a thread about Screen Studio. It does not lead with zoom, because zoom
reads as cosmetic and cosmetic reads as unserious. "Fails the build" is the phrase that
makes an engineer stop, because it is a claim about correctness, and correctness is what
that audience clicks.

Two alternates, worse, in case the first reads badly on the day:

- `Show HN: kaviri – Screen Studio for AI agents, in Rust, Apache 2.0`
- `Show HN: kaviri – your demo video as a build artifact`

The second alternate is the better sentence and the weaker title, because it is abstract.

### The body

Post it as the first comment, not in the URL field. The URL is the GitHub repo.

> I write a lot of agent demos and I kept re-recording the same video by hand every time
> the UI moved. kaviri is the thing I built instead: a Rust CLI that drives headless
> Chromium over CDP from a newline-delimited JSON script and renders an MP4 with the
> zooms and pans Screen Studio does for a human.
>
> Three things in it were more interesting to build than I expected.
>
> **The camera follows the caret, not the pointer.** It records agents. There is no hand on
> a mouse. The cursor it draws is a prop, parked wherever the field was clicked, sitting
> still while a whole sentence types out. The thing actually moving, and the thing a viewer
> is reading, is the text caret. So that is what the camera tracks. Finding it means
> measuring it: for contenteditable that is the selection rectangle, but `input` and
> `textarea` have no caret rectangle in the DOM at all, so the text up to the caret gets
> mirrored into a hidden element with matching typography and the offset of a zero-width
> span at the end is read back. That measurement is a round trip to the page, so it happens
> exactly twice per typing op, before the first character and after the last, and the pan
> is interpolated between them at 0.12s spacing. My first version measured between
> keystrokes. That put the round trip inside the typing rhythm: the text came out slower
> than the requested speed and the camera moved in visible steps, because the samples were
> as uneven as the latency.
>
> The frame also sits left of the control rather than centred on it. A control is to the
> right of whatever it acts on: the send button after the message, the caret after the
> words. Centre on it and you fill the frame with empty space while the thing worth reading
> falls off the left edge.
>
> **It was starving the page it was filming.** The default capture path is a
> `Page.captureScreenshot` pump, roughly one screenshot every 25ms, and each one is a full
> compositor pass plus a JPEG encode inside the same browser running the app. Hardening it
> took one script from 63 seconds to 33. That is 45% of wall clock that was never the app
> being slow, it was me competing with it for CPU. Four output formats that ranged from 59
> to 145 seconds on the same script now land within 2.1 seconds of each other. If you are
> timing-sensitive, `--scale 1` switches to the DevTools screencast, which is far cheaper
> and gets out of the way, at the cost of capping frames at the CSS viewport so zooms crop
> into upscaled pixels.
>
> **A recorder that produces a file is not a recorder that produced a video.** A take that
> filmed a Chrome error page, or a dev server that never came up, is a freeze frame held
> for thirty seconds, and a duration check passes it happily. So the GitHub Action runs in
> CI and the workflow gates on two things: the file is longer than two seconds, and the
> first frame differs from the last by ffmpeg psnr. Identical frames come back as the
> literal `inf`, which is handled as its own case rather than coerced to a number, and
> anything above 50dB is indistinguishable by eye. The demo script navigates, clicks and
> types, so a take whose first and last frames match did not film the product. Job goes
> red.
>
> That last part is the point, more than the zoom. The video stops being a thing you
> remember to redo and becomes a thing that breaks.
>
> Apache 2.0, unconditional, no CLA. One binary, needs Chromium and ffmpeg on PATH, nothing
> phones home. Linux and macOS, Windows untested. No audio yet. I am building a hosted
> version for people who would rather not run a browser, but it is not live and there is no
> price, so there is nothing to sign up for.
>
> kaviri is Shona for "twice, a second time", ka-VEE-ree.

That is the honest engineering story and it is long for HN, deliberately. The audience that
matters reads to the end and the ones who do not were never going to comment.

### The first two hours

This is where it is won or lost. The rules:

**Be at a keyboard for the whole two hours.** Do not post and go to bed. Post at 08:00 to
09:00 US Eastern on a Tuesday, Wednesday or Thursday, which is the window with the most
readers and the least competition from other Show HNs.

**Answer every top-level comment within ten minutes for the first hour.** Speed of reply is
visible and it is read as the author caring. A thread where the author is present stays on
the front page longer than one where they are not.

**Concede fast and completely.** Every objection in section 6 has an honest answer already
written. Use those. If someone finds a real bug, say "that is a bug, here is the issue" and
open the issue in the thread. One public concession buys more credibility than ten
defences.

**Never argue about the name.** See section 6.

**Do not correct people about the licence.** If someone says "Apache 2.0 but the good bits
are hosted", answer with what the recorder does without an account, which is everything.

**Never say "great question".** Never thank someone for a compliment with a paragraph.
Answer the technical content and nothing else.

**Do not ask anyone to upvote it, anywhere, ever.** Voting rings are detected and the
penalty is permanent. Sharing the link once in a group chat of people who would have found
it anyway is fine. A message that says "please upvote" is not.

**Have the demo video working before you post.** The single most common failure of a Show
HN is a repo whose README video is broken or whose install instructions do not work on a
clean machine. Do a clean-clone install on a machine that has never built it, that morning.

**If it dies, it dies.** A Show HN that gets 12 points is not a verdict on the product. Do
not repost. Move to the channels in section 4 and try HN again in six months with the
hosted service.

---

## 4. The other channels, ranked

Ranked by expected return, which here means qualified people who will actually wire the
Action into a repo, divided by hours spent.

### Worth real effort

**1. The GitHub Actions marketplace.** Highest return of anything on this list and the one
most likely to be underrated, because it is not exciting. It is the only channel that
keeps delivering after the launch traffic dies: people search the marketplace at the exact
moment they have the problem, which is the best possible intent. It costs an afternoon of
metadata, a good icon, and a description that leads with the failing-build gate. Do it on
launch day. Note the repo URL inconsistency in the pre-flight list before publishing,
because the marketplace listing hard-codes it.

**2. r/rust.** Small, but the highest quality audience available for this specific artefact.
They will read the source. They will comment on the CDP client being synchronous and
single-threaded, on the dependency-free PNG writer, on the fact that ffmpeg is shelled out
to rather than bound. Those are good conversations and they produce contributors, which is
what you actually need. Post the engineering story, not the pitch. Lead with the caret
measurement or the CPU starvation fix. Mention Screen Studio once, at the end.

**3. Lobsters.** Smaller than HN by an order of magnitude and better read. The tags are
`rust`, `video`, `devops`. **You need an invite**, which you either already have or must
ask someone for, so check this weeks in advance rather than on launch morning. If you post,
post there after HN, not before, and expect three comments that are each worth more than
thirty HN ones.

**4. Devrel at companies whose demos rot most visibly.** This is slow, unglamorous and the
highest conversion rate on the list, because it is the only channel where you are talking
to someone who already has the pain. The targets are companies that ship weekly and put a
video on every feature page: Supabase first (section 2), then the same shape of company.
Developer tool companies with a dashboard, a changelog and a marketing site full of clips
that are visibly older than the UI they show. The approach is always the same: film their
product with kaviri, publish it, then email one named person with the link and no ask in
the first paragraph. Budget one target per week, not ten in a day. Ten in a day is a mail
merge and reads like one.

**5. Console.dev.** A curated newsletter for developer tools with a genuinely relevant
readership and a submission form that takes ten minutes. The expected value is modest but
the cost is nearly zero, so the ratio is good. Submit in the week after launch when there
is a thread to point at.

### Worth some effort, lower expectation

**6. The Changelog.** Getting on the podcast is a real outcome and not a realistic one for
a project with no users yet. Their newsletter and Changelog News are much more reachable
and they cover exactly this kind of thing. Submit to the news, do not pitch the podcast.
Revisit the podcast if the Supabase relationship lands, because "the tool Supabase uses to
film Launch Week" is an episode and "a Rust CLI" is not.

**7. r/programming.** Much larger than r/rust and much worse. It is dominated by low-effort
posts, the comment quality is poor, and a Show-HN-shaped post there often gets removed as
self-promotion depending on which moderator sees it. Post it, because it is fifteen minutes
and the downside is nothing. Expect nothing. Do not spend an hour crafting it.

### Not worth it

**8. Product Hunt.** Skip it. The audience is founders, marketers and other makers, not
engineers who will put a step in a workflow file. The reward is a badge and a spike of
traffic that does not convert. It also demands a launch-day performance: a hunter, a
gallery, comment reciprocity, a whole day of your attention. That day is worth more spent
on the Supabase video. Product Hunt becomes worth reconsidering when there is a hosted
service with a price and a signup, because then the traffic has somewhere to go. Today it
has nowhere to go, since the deliberate answer to "where do I sign up" is "you do not".

**9. African tech press, for the launch.** This needs saying carefully because the
relationships are real and worth keeping. The audience is wrong for this artefact.
A developer-tooling CLI converts through developer channels, and a story in African tech
press reaches founders, investors and ecosystem people who will not wire a GitHub Action
into anything. Spending a relationship on a story that does not convert also spends it: the
next pitch to the same outlet is weaker.

Hold it for the story that is actually there, which is **not the tool**. It is the studio,
the Shona name, a developer tooling product built from Zimbabwe and adopted by companies
abroad. That story is much stronger with a Supabase feature and some adoption in it than it
is on launch day with a repo and no users. Six months out, not now.

**10. Twitter/X and LinkedIn threads.** Post the video, once, on each, on launch day. That
is the whole plan. Do not write a fifteen-tweet thread. The video is the content and it
either travels or it does not. LinkedIn is worth slightly more than usual here because the
devrel people in section 4 item 4 are reachable there, and a post they have already seen
makes the later email warmer.

---

## 5. The first ninety days

### Week minus two and minus one: the quiet beta

The loud launch is a single shot. Spend two weeks making sure the shot is not wasted on
something a clean install would have caught.

Find five to eight people. Not friends being nice. People who will actually try to film
something: two agent builders, two people who maintain a developer tool with a README
video, one person who works in CI all day, one who has never written Rust. Give them the
repo link and one instruction: film your own product, tell me where it broke.

What to watch for, because this is the list that decides whether launch day works:

- Does a clean clone build on a machine that has never built it, on both Linux and macOS?
- Does the thirty-second first run in the README work exactly as written, from the repo
  root, with no network?
- Does the Action work in a repo that is not this one, on a stock `ubuntu-latest`?
- Does anyone's app time out under the default capture path? That is the known sharp edge
  and the README says so, but "the docs mention it" is not the same as a user finding it.
- Which question gets asked twice? That question goes in the README before launch.

Fix what breaks. Ship nothing else. The temptation in this fortnight is to add a feature.
Resist it. Nobody has ever failed a launch for lacking audio capture.

### Week 1: launch

- **Monday.** Pre-flight list (section 7) closed out. Clean-clone install verified on a
  fresh machine. Marketplace listing drafted.
- **Tuesday, 08:30 US Eastern.** Show HN. Two hours at the keyboard, minimum. Nothing else
  scheduled that day.
- **Tuesday, same day.** GitHub Actions marketplace listing published. Video posted once on
  Twitter/X and LinkedIn.
- **Wednesday.** r/rust, written as the engineering story, not a repost of the HN text.
  r/programming, fifteen minutes, no expectations.
- **Thursday, Friday.** Triage. Every issue opened gets a reply within a day, even if the
  reply is "not soon". Fix the small ones immediately and visibly, because a repo that is
  visibly responsive in its first week gets contributors and one that is not never does.
- **Throughout.** Log every inbound message in one file. Mark each one: bug, feature ask,
  or hosting enquiry. The hosting count is the gate and it needs to be counted honestly
  from day one, not reconstructed from memory in week six.

### Week 2: the follow-through

- Lobsters, if the invite is in hand.
- Console.dev submission. Changelog News submission.
- **Start filming the Supabase asset.** This is the week's real work. Script it, film it,
  put it in a public repo with CI, publish it with no ask attached.
- Write down the three questions that came up most in week 1 and answer them in the docs.
  The docs are good and grounded, and the gap after a launch is never accuracy, it is
  knowing which page a confused person needed.
- Do not start the hosted service. Not one line.

### Weeks 3 to 4

- Send the Supabase email, timed as section 2 says: a few days after the video has been
  public, not during a Launch Week.
- Begin the devrel outreach cadence: one company per week, video first, email second.
- First maintenance release. Whatever the launch surfaced, plus whatever of the remaining
  71 audited defects is now visible to users. Ship it with a short changelog. A second
  release in the first month is a signal that the project is alive, and that signal is
  worth more than the contents of the release.

### Weeks 5 to 8

The quiet part, which is where most projects die. The work is unglamorous and it is the
work:

- Keep the outreach cadence. One company a week. Every one gets a video first.
- Answer every issue. Merge every reasonable PR quickly, even small ones, especially small
  ones.
- Write one technical post of your own. The caret measurement, or the CPU starvation fix
  with the before and after numbers. These are genuinely interesting and they are evergreen
  in a way a launch announcement is not.
- **Count the hosting enquiries.** Unprompted only. An enquiry that came after you
  mentioned hosting does not count and counting it defeats the purpose of the rule.

### The gate, at roughly week 8

**The owner's rule: three unprompted "can you host this for us" enquiries.** That rule is
good and the only thing that can damage it is the person who set it deciding, at enquiry
number two, that it was basically three.

The word that carries the weight is **unprompted**. If the reply to "do you host this" is a
link to a signup form, the next enquiry is not evidence. Answer hosting enquiries with a
question instead: what would you want it to do, and what are you doing now. That reply
gathers requirements, keeps the count clean, and costs nothing.

- **Three or more, from three different organisations.** Build it out. First job is to
  apply the SQL to a real Postgres and get one job from `submit_job` to a downloadable
  MP4. Until that has happened, nothing else about the hosted service is real. Then the
  three schema changes the pricing document identifies: a `demos` table, `max_demos` on
  `org_entitlements`, and a priority column read by `lease_next_job` so free work yields to
  paid. Then price.
- **Fewer than three.** Do not build it out. The recorder is still a good thing that exists
  and costs nothing to run. Put the hosted service down, keep counting, and revisit at day
  90. This outcome is not a failure, and pre-committing to that now is the only way it will
  not feel like one in week nine.

### Weeks 9 to 13

Whichever branch the gate chose. If it is the build-out branch, the first paid customer
should be someone who already asked, on a price agreed in an email, before any pricing page
exists. A page can wait until three people have paid the same number without negotiating.

At day 90, review three things and write the answers down: how many repositories have the
Action in a workflow file, how many hosting enquiries, and whether "demo video as a build
artifact" is a phrase anyone other than you has used. The third is the one that tells you
whether the position took.

---

## 6. The things that will go wrong

Answers written now, because comments move faster than thinking does. Each one is short
because a long answer to a hostile question reads as a wound.

### "Nobody can pronounce kaviri"

**Answer:** "ka-VEE-ree. It is Shona for twice, a second time, which is what a re-recording
is." Then stop typing.

Do not defend it further. Do not explain the naming process. Do not offer to consider a
change. The pronunciation is already in the README's second line and in the Show HN post,
which is the correct amount of effort to spend on it. Every unpronounceable name in this
industry survived because the tool was good, and every argument an author has ever had
about their project's name has made the author look worse than the name did.

If it comes up more than twice in the thread, add a phonetic spelling in the repo
description. That is the entire remedy.

### "Why not just Playwright plus ffmpeg?"

This will be the top comment. It deserves the best answer in the thread, and the answer is
not defensive because Playwright is genuinely most of the way there.

**Answer:** "Playwright's video is a raw viewport capture at a fixed zoom. It is correct
and it is unwatchable: text is too small to read on a phone, nothing directs attention, and
a thirty second take is thirty seconds of a wide shot. What kaviri adds is the framing.
Each op emits a timestamped bounding box, those become zoom events, and the events become
a generated ffmpeg zoompan expression: a ladder set by target height and bounded by
whichever axis runs out first, a 0.45s lead-in, a 2.1s hold, cubic smoothstep eases, and
consecutive interactions inside 1.3s merged into one pan with waypoints instead of zooming
out and back in. Plus the caret tracking, which is the part I have not seen anywhere else,
and the psnr gate that fails the build. You could build all of that on Playwright. It is
about two thousand lines of camera logic and a lot of tuning, and if you do, I would rather
read your version than keep maintaining mine."

The last sentence is the important one. Being generous about the alternative is what makes
the rest of the answer credible.

There is a real second-order version of this: "so why is this not a Playwright plugin?"
The honest answer is that the capture path is the hard part, the screenshot pump had to be
rewritten to stop starving the page, and doing that inside someone else's driver lifecycle
was worse than owning the CDP connection. That is a design opinion, not a law, and it
should be stated as one.

### "The wasm playground cannot actually record"

Someone will open it and find it does not produce a video. They will be right.

**Answer:** "Correct, and it should say so more loudly. The wasm build is the planner, not
the recorder. It parses a script, validates the ops and shows you the zoom events the
camera would generate from the marks. It cannot record because recording needs a Chromium
process and an ffmpeg process, and neither exists in a browser tab. Recording is the CLI."

Then fix it the same day: a line at the top of the playground saying *plans a script, does
not record one, recording is the CLI*. If that label is not already there, it is a
pre-flight item. Shipping something labelled "playground" that does the thing the product
is named for, except the one part everyone came to see, is a self-inflicted wound and the
fix is one sentence of copy.

### "Your hosted service is not running"

Someone will resolve the domain, or read the repo, or try the API.

**Answer:** "It is not. It is built and it has never been proven: the SQL has not been
applied to a real Postgres and no job has rendered on a real deployment. That is why there
is no signup and no price. The recorder is the thing that is finished, it is Apache 2.0,
and it needs no account and makes no network call."

This is only damaging if the launch materials implied otherwise. They must not. The README
line is already right. Keep the domain honest: one page saying not live, an email field,
nothing that looks like a product.

### The others, shorter

**"Open core bait and switch. The good bits will go paid."** "The recorder is Apache 2.0,
unconditional, with no revenue threshold, no field-of-use restriction and no CLA. That
licence cannot be revoked on the code as published. I considered a revenue-threshold
licence and rejected it specifically because I want people to be able to call this open
source without qualification. The hosted service is convenience, a queue and storage and a
URL, and everything the CLI does locally it will keep doing locally."

**"Another Rust rewrite of a shell script."** "A fair reading of about half of it. The
parts that are not a shell script are the camera, which is real geometry over timestamped
boxes, the caret measurement, and the capture pump, which needed careful backpressure to
stop starving the page. The ffmpeg invocation genuinely is a shell script and it is called
as one."

**"63 to 33 seconds, on what?"** Give the specifics and do not round them: the same script,
the same machine, before and after the capture path was hardened, and the four formats that
ranged from 59 to 145 seconds now landing within 2.1 seconds of each other. If pressed for
a reproducible benchmark, say it is not one yet and offer to publish the scripts. Then
publish them.

**"No audio makes this useless for real demos."** "Agreed for narrated demos, and it is the
top of the list. `--audio` warns and is ignored today rather than pretending. The plan is a
dedicated PipeWire or Pulse sink for the browser process, muxed against the same clock. For
now, narration goes on in an editor afterwards."

**"Windows?"** "Untested and unsupported. Not out of principle, just untested. A working
report or a PR would change that."

**"A demo video should be made by a human who cares."** "For a launch film, yes, and this
does not replace that. This is for the twelve videos on the docs pages and feature pages
that nobody will ever re-record by hand, which are the ones currently showing a UI from
2024."

**Someone finds a bug in the first hour.** They will. There were 86 audited defects and 15
ship-blockers fixed, so 71 remain by that count and some of them are reachable. The
response is always the same: reproduce it, say "that is a bug", open the issue, link it in
the thread, fix it that week if it is small. Never explain why it is not really a bug. A
launch thread with three bugs found and three issues opened within the hour reads as a
live project. A launch thread with three bugs argued about reads as a dead one.

---

## 7. Pre-flight, before anything is public

Nothing ships until every line here is closed.

- [ ] **The repository URL is one URL.** `kaviri`'s README and `Cargo.toml` point at
      `github.com/thisisisheanesu/kaviri`. `kaviri-cloud`'s README links
      `github.com/vamboai/kaviri`. One of those is wrong and both are currently public-
      facing. The marketplace listing, the `uses:` line in every docs example and the
      `cargo install --git` snippet in `docs/ci.md` all hard-code it, so fix it once and
      grep for the rest.
- [ ] **`cargo install --git` in `docs/ci.md` actually works** against the public repo, or
      the snippet comes out. It was written from `Cargo.toml` and never run.
- [ ] **`docs/PRICING.md` moves to `kaviri-billing`** before `kaviri-cloud` goes public. It
      contradicts that repo's own README and only passes `check-seam.sh` because
      documentation is exempt.
- [ ] **The wasm playground says it does not record**, in the first line a visitor reads.
- [ ] **Clean-clone build verified** on a Linux machine and a macOS machine that have never
      built it, including the thirty-second first run exactly as the README writes it.
- [ ] **The Action verified in a third-party repo** on stock `ubuntu-latest`, with both
      gates passing on a good take and the psnr gate failing on a deliberately broken one.
      Prove the differentiator before claiming it.
- [ ] **`kaviri.dev` resolves to an honest page.** Not live, an email field, no tiers, no
      signup button.
- [ ] **No price anywhere public.** None exists yet.
- [ ] **No testimonials, no logos, no user counts.** There are none.
- [ ] **The Supabase demo video contains no credential**, checked frame by frame, with the
      telemetry sidecar off.
- [ ] **Lobsters invite** secured, or that channel is dropped without ceremony.
