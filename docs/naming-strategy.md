# Nitely Naming Strategy

Decision date: 2026-07-14

This memo is a dated product-naming decision, not legal advice and not a trademark clearance.
Availability and search results can change after the
query time. No domain, package, handle, trademark, or replacement name was
purchased, published, reserved, or registered as part of this review.

## Decision

**Rename before public launch.** Keep `Nitely` only as a temporary internal
repository and package codename while a replacement is selected and cleared.
Do not publish or launch a public landing page, SaaS control plane, paid offer,
or public package under `Nitely` or `Nightly`.

The reason is cumulative rather than a claim that one discovered use is
necessarily legally blocking:

- the exact-match `.com`, `.dev`, `.ai`, and `.ca` domains already have registry
  records;
- an exact-name consumer software product, Nitely Toronto, is already in
  active commercial use;
- other exact-name commercial and open-source uses make search ownership weak;
- `Nightly`, the natural spelling correction, is both a software release term
  and an actively used software brand; and
- a longer domain such as `getnitely.com` would change the address, not the
  word customers say, search, or compare.

The replacement should be a distinctive coined or suggestive mark that can
cover governed, auditable workflows beyond software development. It should be
easy to hear and spell, should not depend on an exact-match domain hack, and
must pass the launch gate below. This memo deliberately does not propose a
winner: publishing unsearched replacement candidates would create another
naming commitment before clearance.

## Options Compared

| Option | Advantages | Material drawbacks | Decision |
| --- | --- | --- | --- |
| **Keep Nitely** with a workaround domain | No immediate code or documentation migration; the unscoped npm registry endpoint returned no `nitely` package object on the decision date. | Exact core domains are registered; exact-name software and businesses already appear in first-party results; the spelling must be explained; the GitHub handle is occupied; a different URL does not make the spoken mark distinctive. | Reject for a public brand. |
| Keep the repository/package codename but use a **longer commercial brand** | Can defer a source-code migration and make the buyer-facing promise more explicit. | If `Nitely` remains the dominant word, the collision and spelling problems remain. If the dominant word is genuinely new, this is effectively a staged rename and still needs full clearance. | Accept only as a short migration mechanism, with the new distinctive mark dominant and `Nitely` absent from launch assets. |
| **Rename before public launch** | Best chance of owning search results, obtaining coherent domains/handles, reducing customer spelling friction, and expanding beyond overnight or developer-only associations. | Requires a bounded migration of CLI/package/repository/docs and a fresh clearance search. | **Recommended.** The cost is lowest before a public launch and customer adoption. |

The 404 responses below are useful screening signals, not reservations. Even if
`getnitely.com`, `nitelyhq.com`, or an unscoped npm name can be registered, they
do not change this recommendation.

## Dated Availability And Collision Checks

All checks in this section were performed on 2026-07-14. Registry/API results
are linked directly so they can be rerun. An RDAP HTTP 404 means that the
queried server returned no domain object at that moment; it does **not**
guarantee registrar availability, ordinary pricing, eligibility, or absence of
reserved and premium-name rules.

### Domains

| Name | Dated official result | Implication |
| --- | --- | --- |
| `nitely.com` | [Verisign `.com` RDAP](https://rdap.verisign.com/com/v1/domain/nitely.com) returned a domain object, registered 2004-07-21 with the displayed expiration 2026-07-21. | Occupied at query time. A displayed expiration date is not an availability date. |
| `nitely.dev` | [Google Registry `.dev` RDAP](https://pubapi.registry.google/rdap/domain/nitely.dev) returned a domain object, registered 2019-12-10 with the displayed expiration 2026-12-10. | Occupied at query time. |
| `nitely.ai` | [Identity Digital `.ai` RDAP](https://rdap.identitydigital.services/rdap/domain/nitely.ai) returned a domain object, registered 2025-12-08 with the displayed expiration 2027-12-08. | Occupied at query time. |
| `nitely.ca` | [CIRA `.ca` RDAP](https://rdap.ca.fury.ca/rdap/domain/nitely.ca) returned a domain object, registered 2026-02-26 with the displayed expiration 2027-02-26. | Occupied and used by the exact-name consumer app described below. |
| `getnitely.com` | [Verisign RDAP](https://rdap.verisign.com/com/v1/domain/getnitely.com) returned HTTP 404. | Candidate for a live registrar checkout only; not proof of availability and not a brand-risk remedy. |
| `nitelyhq.com` | [Verisign RDAP](https://rdap.verisign.com/com/v1/domain/nitelyhq.com) returned HTTP 404. | Same limitation. |
| `usenitely.com` | [Verisign RDAP](https://rdap.verisign.com/com/v1/domain/usenitely.com) returned HTTP 404. | Same limitation. |
| `trynitely.com` | [Verisign RDAP](https://rdap.verisign.com/com/v1/domain/trynitely.com) returned HTTP 404. | Same limitation. |
| `getnitely.dev` | [Google Registry RDAP](https://pubapi.registry.google/rdap/domain/getnitely.dev) returned HTTP 404. | Same limitation, including `.dev` pricing and policy checks. |
| `nitelyhq.dev` | [Google Registry RDAP](https://pubapi.registry.google/rdap/domain/nitelyhq.dev) returned HTTP 404. | Same limitation. |
| `getnitely.ai` | [Identity Digital RDAP](https://rdap.identitydigital.services/rdap/domain/getnitely.ai) returned HTTP 404. | Same limitation, including `.ai` pricing and policy checks. |
| `nitelyhq.ai` | [Identity Digital RDAP](https://rdap.identitydigital.services/rdap/domain/nitelyhq.ai) returned HTTP 404. | Same limitation. |
| `nitely.io`, `getnitely.io`, `nitelyhq.io` | The [IANA RDAP DNS bootstrap file](https://data.iana.org/rdap/dns.json) did not list a `.io` service endpoint at query time, so no registry result is asserted. | Unresolved; verify with the current registry and an accredited registrar before relying on any candidate. |

No purchase or registration was attempted. Domain status must be rechecked at
the moment a cleared replacement name is approved.

### npm and GitHub namespaces

| Name or query | Dated official result | Implication |
| --- | --- | --- |
| npm `nitely` | The [npm registry endpoint](https://registry.npmjs.org/nitely) returned HTTP 404. | No public package object was returned, but npm may reserve or restrict names. A dry run can inspect package contents but cannot prove registry acceptance, namespace policy, or publish permission; those remain unproven until an authorized release attempt after name clearance. |
| npm `nightly` | The [npm registry endpoint](https://registry.npmjs.org/nightly) returned a package whose latest tag was `0.0.0`. | Exact natural spelling is occupied. |
| npm `getnitely`, `nitelyhq`, `usenitely`, `trynitely` | The official registry endpoints for [getnitely](https://registry.npmjs.org/getnitely), [nitelyhq](https://registry.npmjs.org/nitelyhq), [usenitely](https://registry.npmjs.org/usenitely), and [trynitely](https://registry.npmjs.org/trynitely) returned HTTP 404. | Screening only; these longer package names do not cure the public-brand problem. |
| GitHub `nitely` handle | The [GitHub users API](https://api.github.com/users/nitely) identifies an existing user created in 2012. | The exact GitHub account/organization handle is occupied. |
| GitHub `nightly` handle | The [GitHub users API](https://api.github.com/users/nightly) identifies an existing user created in 2019. | The natural spelling handle is occupied. |
| GitHub repository search for `nitely` in names | The public [GitHub Search API](https://api.github.com/search/repositories?q=nitely%20in%3Aname&per_page=100) returned dozens of repositories and multiple exact public `nitely` repository names. | Public search results are not uniquely owned by this project; counts vary with index state. |
| GitHub repository search for `nightly` in names | The [GitHub Search API](https://api.github.com/search/repositories?q=nightly%20in%3Aname&per_page=100) returned 2,534 repositories and numerous exact `nightly` repository names. | `Nightly` is exceptionally noisy in software search; the count is a dated snapshot. |

A scoped package under the owning organization is preferable for any future
name, but scope ownership and package publish permissions must be verified
separately. A package-registry 404 is never a substitute for trademark or
domain clearance.

### Existing software, commercial use, and search meaning

- [Nitely Toronto on Apple's App Store](https://apps.apple.com/us/app/nitely-toronto/id6758633905)
  identifies the app as **Nitely**, describes it as Toronto's real-time
  nightlife app, links to `nitely.ca`, and shows version 1.0 dated 2026-03-12.
  Apple's listing was live when queried on 2026-07-14. This is exact-name
  commercial software, although its nightlife function and purchasers differ
  from this project's governed developer workflows.
- [Nitely Toronto's first-party site](https://nitely.ca/) presented an install
  invitation for the Nitely phone app when queried on 2026-07-14. The official
  `.ca` RDAP record above was created before this repository's public-brand
  decision.
- [Nitely Management](https://www.nitely.co.za/) described an active Cape Town
  short-term-rental property-management service and its software-enabled
  booking operations when queried on 2026-07-14. This is a different service
  category, but it is another exact commercial use and search-result claimant.
- [Webflow's Nitely template listing](https://templates.webflow.com/html/nitely-event-website-template)
  offered a paid nightlife/event website template under the exact word when
  queried on 2026-07-14. It is not treated as a trademark conclusion, only as
  evidence that exact-word search results already span multiple sellers.
- [Nightly Wallet](https://nightly.app/) described an active multichain browser
  extension and mobile software wallet when queried on 2026-07-14. It is a
  separate spelling, but visually and aurally close enough that it belongs in a
  preliminary search.
- Mozilla markets [Firefox Nightly](https://www.mozilla.org/en-US/firefox/channel/desktop/)
  as its frequently updated pre-release browser, and Google publishes
  [Android Studio Nightly](https://developer.android.com/studio/nightly) builds.
  Both official pages were live on 2026-07-14. These uses show that “nightly”
  already has a strong software meaning: an automated or pre-release build,
  not a governed approval-to-PR product.

The combination creates two practical problems even before legal analysis.
Searching `Nitely` can return nightlife, hospitality, templates, code, and this
project; spelling the name aloud can send a customer to the much noisier
`Nightly` search space. Adding `get`, `use`, or `hq` to a domain does not change
either behavior.

## Preliminary Trademark Risk

**Preliminary risk: medium to high for a public software brand, with material
unknowns.** This rating is a product-risk screen, not a legal conclusion.

The [USPTO's official search guidance](https://www.uspto.gov/trademarks/search/federal-trademark-searching)
says potentially conflicting marks should be evaluated for similarity in
appearance, sound, meaning, and commercial impression, together with whether
the goods or services are related. The same guidance warns that international
class alone is not decisive, dead federal records can coexist with enforceable
common-law use, and a federal database search cannot provide a clear-cut
registration answer.

Applying that framework cautiously:

- `Nitely` and `Nightly` are likely to be pronounced alike and create the same
  overnight commercial impression.
- Exact `Nitely` use on a currently distributed phone app is closer than a
  merely similar name because both are software, even though the app's purpose
  and customer set differ.
- Nightly Wallet is active software under the near-identical spelling, while
  Firefox and Android Studio make `nightly` weak as a unique software search
  term.
- Nitely Management and the Webflow template are farther from developer tools,
  but demonstrate broader commercial adoption of the same word.

Official databases considered for the next-stage search are the
[USPTO Trademark Search](https://tmsearch.uspto.gov/),
[WIPO Global Brand Database](https://branddb.wipo.int/), and
[EUIPO eSearch plus](https://euipo.europa.eu/eSearch/). On 2026-07-14 their
interactive result sets did not yield a stable, reproducible export suitable
for asserting “no conflicts” in this repository. No individual application or
registration is therefore claimed as cleared, blocking, live, dead, owned, or
class-matched by this memo. That is an explicit evidence limit, not a clean
search result.

The search must also cover relevant common-law/company/app-store uses and
phonetic variants, not only exact federal records. Qualified trademark counsel
should run and interpret that search in each intended launch market.

## Public-Launch Gate

Do not publish or launch the public brand until all of these are recorded in a
follow-up decision:

1. Select three to five distinctive replacement candidates against a written
   brief: governed and auditable workflows, pronounceable on first hearing,
   spelling unambiguous, and capable of expansion beyond coding workflows.
2. Run same-day official domain, npm, GitHub, app-store, company-name, and web
   searches for every candidate and its likely misspellings. Treat 404 and
   “no result” responses as screening evidence only.
3. Have qualified trademark counsel complete and document a professional
   clearance across the intended jurisdictions, including USPTO/WIPO/EUIPO
   records, related goods and services, phonetic variants, and common-law use.
4. Only after legal approval, acquire the coherent domain set and defensive
   misspellings, establish the organization/scoped package namespaces, and
   record renewal/credential ownership. Recheck availability at transaction
   time.
5. Approve a migration map for the CLI binary, package name, repository,
   configuration/environment prefixes, runtime-state compatibility, docs,
   links, and attribution. Preserve an explicit deprecation window where
   technically necessary.
6. Verify the replacement with representative buyers before committing public
   launch assets, then record the final mark, owner, evidence date, and counsel
   sign-off in this file or a superseding decision record.

Until those steps pass, `Nitely` is an internal codename, not a claim that the
name is available or safe for commercial launch.
