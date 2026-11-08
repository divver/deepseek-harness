# Bundled skill sources

Every directory here is vendored from an MIT-licensed upstream and may carry
local adaptations for the coop role model. Upstream repos:

| Source | Repo | Local checkout |
|---|---|---|
| pstack (mirror of cursor/plugins/pstack) | https://github.com/backnotprop/pstack | `~/Documents/work/bamfly/agent/pstack` |
| superpowers | https://github.com/obra/superpowers | `~/Documents/work/bamfly/agent/superpowers` |
| matt-skills | https://github.com/mattpocock/skills | `~/Documents/work/bamfly/agent/matt-skills` |

| Skill | Origin | Local changes |
|---|---|---|
| architect, benchmark-checklist, blast-radius, how, ketchup, recall, reflect, sharpen, why | pstack `skills/<name>` | none (verbatim copy incl. references/) |
| tdd, typescript-best-practices, figure-it-out, interrogate, unslop, no-comments | pstack `skills/<name>` | removed `disable-model-invocation: true` so worker/reviewer nodes can load them on wake per the `coop:policy` section (upstream is user-invoked-only for poteto-mode's manual UX) |
| brainstorming, systematic-debugging | superpowers `skills/<name>` | none |
| diagnosing-bugs, grilling, handoff | mattpocock/skills (`skills/engineering|productivity/<name>`) | none; `agents/openai.yaml` kept (harness display metadata) |
| coop-flow, coop-help | self-written for dsh-coop | n/a |

Notes:

- Frontmatter is unparsed-except-name/description/invocation: extra keys
  (`icon`, `color`, …) are tolerated by the registry as metadata.
- Invocation policy: policy-named auto skills (`tdd`, `typescript-best-practices`,
  `figure-it-out`, `interrogate`, `unslop`, `no-comments`, plus upstream
  model-invocable `diagnosing-bugs`, `systematic-debugging`, `brainstorming`,
  `grilling`) load on wake; the rest stay user/master-picked by name.
- Same-name user-level skills (rank 400) override these bundled copies
  (rank 600) — install your own edition to replace one.
