# pi-nexus-laya — unified Laya-inspired extension for pi

> **Single dep: none.** One `pi` harness evaluate — no extra Chrome/playwright.  
> General, area-agnostic: context + prompt + harness + loop + graph — **2-4 LLM calls**.

Port of ideas from `browser-use/jev-ultrafast` (atomic snapshot) + `laya` (typed decisions in one pass). Adapted for `pi` harness, not browser.

## Install

```bash
pi --extension ./extensions/nexus-laya/index.ts
# or
pi install git:github.com/you/pi-nexus-laya
pi tools:list # nexus_launch, nexus_snapshot, nexus_act, nexus_text
```

## Tools (4 minimal)

| Tool | Purpose |
|---|---|
| `nexus_launch {query?}` | Atomic harness snapshot `50k->12k ranked` + `e1..250` with `y/onscreen/frame` |
| `nexus_snapshot {query?, compact?}` | Re-observe one evaluate |
| `nexus_act {actions:[{id,text?}]} 1..5` | Batched typed `operation+target` -> auto re-observe + guard |
| `nexus_text {query?|offset|blockIndex?}` | Live pagination beyond 12k |

## Workflow

```ts
nexus_launch {query:"auth middleware"} // ranked 12k + e1..250
nexus_act [{"id":"e12"}] // click/harness act
nexus_act [{"id":"e13","text":"new guideline"}] // fill/prompt edit batched
nexus_text {query:"rate limit"} // search live text
nexus_text {offset:-5000} // tail
nexus_text {blockIndex:3} // nth block
```

## Design

- One atomic `collectSnapshot()` - 5 roots like `snapshot.js` shadow+iframe scan
- Typed choice via `TypeBox` - must emit `{"id":"e12"}` not free-form
- Ranked `50k->12k` TF-IDF+heading - same as browser-laya
- Guards + fingerprint stale -> re-observe without LLM call
- Dedup + prio `context/prompt first, onscreen first` before 250 cap

## Laya Mapping

| Laya | Nexus |
|---|---|
| Typed `choice/score` | `TypeBox {id:eXX, text?}` |
| One pass many questions | `nexus_act batch 1..5` |
| Router per request | `tool routing via query` |
| Calibrated guards | `fingerprint + disabled check` |
| Hooks | `before_agent_start / agent_before_settle / session_shutdown` |

Not affiliated with `laya` - pattern only.
