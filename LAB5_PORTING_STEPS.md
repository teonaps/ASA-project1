# Porting Lab5 (PDDL planning) into Agent_1 — Step-by-Step Guide

This document lists, in order, everything you need to **add**, **fix**, and **implement** to evolve `Agent_1/intention_revision.js` (currently a Lab4-style BDI loop) into a working Lab5 PDDL-planning agent.

---

## 0. Prerequisites

Confirm `package.json` already declares:

```json
"@unitn-asa/deliveroo-js-sdk": "^1.3.4",
"@unitn-asa/pddl-client":      "^1.7.5",
"dotenv":                      "^17.4.2"
```

Run `npm install` if `node_modules/@unitn-asa/pddl-client` is missing.

Confirm the imports at the top of `intention_revision.js` already include:

```js
import { readFile } from 'fs/promises';
import {
  PddlDomain, PddlAction, PddlProblem,
  PddlExecutor, onlineSolver, Beliefset
} from "@unitn-asa/pddl-client";
```

(They do — `intention_revision.js:1-5`.)

---

## 1. Fix bugs in the existing Lab4 code

Before adding anything new, fix what's already broken or wrong in `Agent_1/intention_revision.js`:

### 1.1 Wrong predicate index for parcel id

`intention_revision.js:219` reads:

```js
let id = intention.predicate[2]
let p  = parcels.get(id)
```

But the predicate is `['go_pick_up', x, y, id]` — `id` lives at index **3**, not 2. Index 2 is the `y` coordinate (a number), so the `parcels.get(id)` lookup never matches.

**Fix:**

```js
let id = intention.predicate[3]
let p  = parcels.get(id)
```

### 1.2 (Carry-over from Lab5) `tiles.find` callback

If you copy Lab5's `onMap` handler (step 3 below), do **not** copy the line:

```js
let right = tiles.find( (_x,_y) => x == _x+1 && y == _y );
```

`Array.prototype.find` passes the **whole element**, not destructured coords. The version below is correct:

```js
let right = tiles.find( t => t.x === x + 1 && t.y === y );
```

### 1.3 (Carry-over from Lab5) Stray `ù` character

Lab5's `intention_revision.js:437` has a typo:

```js
var plan = await onlineSolver( domain, problem );ù
```

Drop the trailing `ù` when porting — it's a syntax error.

### 1.4 (Carry-over from Lab5) `this.parent` vs `this.#parent`

Lab5 line 272 instantiates plans with `new planClass(this.parent)` (broken — `parent` is a private field). Your `Agent_1` copy already uses `this.#parent` correctly. **Keep yours.**

---

## 2. Build a Beliefset of the map

The PDDL planner needs to know which tiles exist, where deliveries are, and which tiles are adjacent.

### 2.1 Declare the beliefset (after the parcels block, ~line 78)

```js
const myBeliefset = new Beliefset();

socket.onMap( (width, height, tiles) => {
    for (let { x, y, delivery } of tiles) {
        myBeliefset.declare( `tile ${x}_${y}` );
        if (delivery) myBeliefset.declare( `delivery ${x}_${y}` );

        const right = tiles.find( t => t.x === x + 1 && t.y === y );
        if (right) myBeliefset.declare( `right ${x}_${y} ${right.x}_${right.y}` );

        const left = tiles.find( t => t.x === x - 1 && t.y === y );
        if (left)  myBeliefset.declare( `left ${x}_${y} ${left.x}_${left.y}` );

        const up = tiles.find( t => t.x === x && t.y === y + 1 );
        if (up)    myBeliefset.declare( `up ${x}_${y} ${up.x}_${up.y}` );

        const down = tiles.find( t => t.x === x && t.y === y - 1 );
        if (down)  myBeliefset.declare( `down ${x}_${y} ${down.x}_${down.y}` );
    }
});
```

### 2.2 Track agent position in the beliefset

Inside `socket.onYou`, after updating `me`, sync the agent's PDDL position:

```js
socket.onYou( ({ id, name, x, y, score }) => {
    me.id = id; me.name = name; me.x = x; me.y = y; me.score = score;

    myBeliefset.declare( `me ${id}` );
    // remove previous "at" facts for me, then declare current one
    for (const fact of myBeliefset.entries.map(([f]) => f)) {
        if (fact.startsWith(`at ${id} `)) myBeliefset.undeclare(fact);
    }
    if (Number.isInteger(x) && Number.isInteger(y)) {
        myBeliefset.declare( `at ${id} ${x}_${y}` );
    }
});
```

> Only declare `at` when the coordinates are integers — the agent is mid-tile during a move, and the planner only understands integer tiles.

---

## 3. Create the PDDL domain file

Create **`Agent_1/domain-deliveroo.pddl`** with all four movement actions. Lab5's file (`lab5-APIsForPlanning/domain-deliveroo.pddl`) ships only `right` — you must add the rest.

```pddl
;; domain file: domain-deliveroo.pddl
(define (domain default)
    (:requirements :strips)
    (:predicates
        (tile ?t)
        (delivery ?t)
        (agent ?a)
        (parcel ?p)
        (me ?a)
        (at ?agentOrParcel ?tile)
        (right ?t1 ?t2)
        (left  ?t1 ?t2)
        (up    ?t1 ?t2)
        (down  ?t1 ?t2)
    )

    (:action right
        :parameters (?me ?from ?to)
        :precondition (and (me ?me) (at ?me ?from) (right ?from ?to))
        :effect       (and (at ?me ?to) (not (at ?me ?from)))
    )

    (:action left
        :parameters (?me ?from ?to)
        :precondition (and (me ?me) (at ?me ?from) (left ?from ?to))
        :effect       (and (at ?me ?to) (not (at ?me ?from)))
    )

    (:action up
        :parameters (?me ?from ?to)
        :precondition (and (me ?me) (at ?me ?from) (up ?from ?to))
        :effect       (and (at ?me ?to) (not (at ?me ?from)))
    )

    (:action down
        :parameters (?me ?from ?to)
        :precondition (and (me ?me) (at ?me ?from) (down ?from ?to))
        :effect       (and (at ?me ?to) (not (at ?me ?from)))
    )
)
```

---

## 4. Add a `PddlMove` plan class

Replace Lab5's broken `PddlMove` (`lab5/intention_revision.js:418-445`) with a working version. Add it **after** `BlindMove` in `intention_revision.js`:

```js
class PddlMove extends Plan {

    static isApplicableTo (go_to, x, y) {
        return go_to === 'go_to';
    }

    async execute (go_to, x, y) {
        if (this.stopped) throw ['stopped'];

        const pddlProblem = new PddlProblem(
            'deliveroo',
            myBeliefset.objects.join(' '),
            myBeliefset.toPddlString(),
            `at ${me.id} ${x}_${y}`
        );
        const problem = pddlProblem.toPddlString();
        const domain  = await readFile('./domain-deliveroo.pddl', 'utf8');

        const plan = await onlineSolver(domain, problem);
        if (!plan) throw ['no_plan_found'];
        if (this.stopped) throw ['stopped'];

        // Execute each step against the live socket and update `me`
        for (const step of plan) {
            if (this.stopped) throw ['stopped'];
            const dir = step.action.toLowerCase(); // 'right' | 'left' | 'up' | 'down'
            const moved = await socket.emitMove(dir);
            if (!moved) throw 'stucked';
            me.x = moved.x; me.y = moved.y;
        }

        return true;
    }
}
```

> Why not `PddlExecutor`? It executes the plan abstractly (logging) but doesn't drive the SDK. We iterate `plan` ourselves so each action becomes a real `socket.emitMove(dir)` and we keep `me` in sync — same pattern as `BlindMove`.

---

## 5. Register the new plan in the library

At the bottom of `intention_revision.js`, add `PddlMove` **before** `BlindMove` so the planner is tried first and `BlindMove` becomes a fallback:

```js
planLibrary.push( GoPickUp )
planLibrary.push( PddlMove )
planLibrary.push( BlindMove )
```

The `Intention.achieve()` loop already tries plans in order and falls through on error, so a planner failure (no path, server down) will gracefully degrade to greedy movement.

---

## 6. (Recommended) Add delivery — currently the agent never scores

Picking up parcels without delivering them never increments `score`. Add a delivery option and plan:

### 6.1 Track carried parcels in `optionsGeneration`

```js
const carrying = [...parcels.values()].filter(p => p.carriedBy === me.id);
if (carrying.length > 0) {
    // pick nearest delivery tile from beliefset
    const deliveries = myBeliefset.objects.filter(o =>
        myBeliefset.entries.find(([f, v]) => v && f === `delivery ${o}`));
    // … choose nearest, push ['go_put_down', dx, dy]
    myAgent.push(['go_put_down', dx, dy]);
}
```

### 6.2 Add a `GoPutDown` plan

```js
class GoPutDown extends Plan {
    static isApplicableTo (go_put_down, x, y) {
        return go_put_down === 'go_put_down';
    }
    async execute (go_put_down, x, y) {
        if (this.stopped) throw ['stopped'];
        await this.subIntention( ['go_to', x, y] );
        if (this.stopped) throw ['stopped'];
        await socket.emitPutdown();
        return true;
    }
}
planLibrary.push( GoPutDown )
```

---

## 7. (Optional) Smarter intention revision

`IntentionRevisionRevise` (line 286) is a stub. Replace its `push` with utility-based ordering:

```js
async push (predicate) {
    const utility = (pred) => {
        const [type, x, y, id] = pred;
        if (type === 'go_pick_up') {
            const p = parcels.get(id);
            if (!p) return -Infinity;
            return p.reward - distance({x, y}, me);
        }
        if (type === 'go_put_down') return 1000; // delivery is always top priority
        return 0;
    };

    const intention = new Intention(this, predicate);
    this.intention_queue.push(intention);
    this.intention_queue.sort((a, b) => utility(b.predicate) - utility(a.predicate));

    // stop the currently running one if a better one came up
    if (this.intention_queue[0] !== intention) return;
    const running = this.intention_queue[1];
    if (running) running.stop();
}
```

Switch the active agent to `new IntentionRevisionRevise()` once the utility logic is in.

---

## 8. Run order — how to test each step

1. After **step 1 (bug fixes)**: run `node intention_revision.js`; the agent should still behave like Lab4 (greedy nearest-parcel pick-up) — but the "intention skipping" log line should now actually fire when a parcel is carried by another agent.
2. After **steps 2–5 (PDDL movement)**: watch the console for `at ${me.id} ${x}_${y}` problems being printed and a non-empty `plan` array. The agent should now navigate around obstacles instead of getting stuck on walls.
3. After **step 6 (delivery)**: `me.score` should start increasing.
4. After **step 7 (utility revision)**: the agent should ignore far-but-low-value parcels in favor of close-or-valuable ones, and always prefer delivering when carrying.

---

## 9. Quick checklist

- [ ] Fixed `predicate[2]` → `predicate[3]` (parcel id lookup)
- [ ] Created `domain-deliveroo.pddl` with `right`/`left`/`up`/`down`
- [ ] Added `Beliefset` + `socket.onMap` handler with corrected `find`
- [ ] Sync `at me X_Y` inside `socket.onYou`
- [ ] Added working `PddlMove` plan that drives `socket.emitMove`
- [ ] Pushed `PddlMove` to `planLibrary` before `BlindMove`
- [ ] (Recommended) Added `go_put_down` option + `GoPutDown` plan
- [ ] (Optional) Implemented utility-based `IntentionRevisionRevise`

Once all boxes above are ticked, the agent senses → updates beliefs → generates options → revises intentions → and either plans a path with PDDL or falls back to BlindMove — the full Lab5 control cycle.
