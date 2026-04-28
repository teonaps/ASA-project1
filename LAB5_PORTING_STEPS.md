<!--
============================================================
  WHAT IS THIS FILE?
============================================================
  This is a step-by-step recipe to upgrade `Agent_1/intention_revision.js`
  from a "Lab4 agent" (one that just walks straight toward parcels and
  gets stuck on walls) into a "Lab5 agent" (one that uses a real PDDL
  planner to compute a path around obstacles).

  Read it top to bottom. Each numbered section is one task. Inside each
  task you'll find:
    - a short plain-English explanation of WHY the step exists,
    - the exact code/text you need to add,
    - a note on what could go wrong.

  By the end, your agent will: sense the world -> update its beliefs ->
  pick the best parcel -> ask a planner for a route -> execute the route
  -> deliver the parcel for points.
============================================================
-->

# Porting Lab5 (PDDL planning) into Agent_1 — Step-by-Step Guide

<!--
  PLAIN-ENGLISH SUMMARY
  ---------------------
  Lab4 = "blind" agent: looks at parcels, walks toward the nearest one,
         bumps into walls, gives up.
  Lab5 = "smart" agent: same brain, but instead of walking blindly it
         describes the map to a PDDL solver ("here are the tiles, here
         is where I am, take me to (x,y)") and the solver returns a
         step-by-step route the agent then executes.

  This file is the bridge between the two.
-->

This document lists, in order, everything you need to **add**, **fix**, and **implement** to evolve `Agent_1/intention_revision.js` (currently a Lab4-style BDI loop) into a working Lab5 PDDL-planning agent.

---

## 0. Prerequisites

<!--
  WHY THIS STEP?
  Before writing any code, make sure the libraries you depend on are
  actually installed and imported. Skipping this step leads to
  "module not found" errors that look scary but mean nothing more
  than "you forgot to install something".
-->

Confirm `package.json` already declares:

```json
"@unitn-asa/deliveroo-js-sdk": "^1.3.4",
"@unitn-asa/pddl-client":      "^1.7.5",
"dotenv":                      "^17.4.2"
```

<!--
  - deliveroo-js-sdk: lets your code TALK to the game server (move,
    pickup, putdown, listen for events).
  - pddl-client:      gives you the PDDL classes (Beliefset, PddlProblem,
    PddlDomain, onlineSolver, ...). It's the planner library.
  - dotenv:           reads a .env file so you don't hard-code your
    auth token in source.
-->

Run `npm install` if `node_modules/@unitn-asa/pddl-client` is missing.

Confirm the imports at the top of `intention_revision.js` already include:

```js
import { readFile } from 'fs/promises';
import {
  PddlDomain, PddlAction, PddlProblem,
  PddlExecutor, onlineSolver, Beliefset
} from "@unitn-asa/pddl-client";
```

<!--
  readFile: needed to load `domain-deliveroo.pddl` from disk at runtime.
  The other imports are the planner toolkit (see step 4).
-->

(They do — `intention_revision.js:1-5`.)

---

## 1. Fix bugs in the existing Lab4 code

<!--
  WHY THIS STEP?
  Don't pile new features on top of broken foundations. The current
  Agent_1 file (and the Lab5 example file you'll copy from) contain
  small but real bugs. Fix them first so you can tell whether new
  problems come from your additions or from inherited mistakes.
-->

Before adding anything new, fix what's already broken or wrong in `Agent_1/intention_revision.js`:

### 1.1 Wrong predicate index for parcel id

<!--
  THE STORY
  An "intention" is an array like ['go_pick_up', x, y, id].
  The validity-check code reads predicate[2] thinking that's the id,
  but [2] is actually `y` (a number). So the agent never finds the
  parcel in its map and the "skip if already carried" guard never
  fires. Bug since Lab4. Fix is one character.
-->

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

<!--
  THE STORY
  Array.find() passes ONE argument: the current element.
  Lab5 wrote `(_x, _y) => ...` as if find() destructured x/y. It does not.
  Result: `_y` is always undefined, the right-neighbour lookup is broken,
  and the planner thinks the map has no edges. The fix is to receive
  the whole tile object and read `.x` / `.y` off it.
-->

If you copy Lab5's `onMap` handler (step 3 below), do **not** copy the line:

```js
let right = tiles.find( (_x,_y) => x == _x+1 && y == _y );
```

`Array.prototype.find` passes the **whole element**, not destructured coords. The version below is correct:

```js
let right = tiles.find( t => t.x === x + 1 && t.y === y );
```

### 1.3 (Carry-over from Lab5) Stray `ù` character

<!--
  THE STORY
  Pure typo. Someone hit `ù` after a semicolon. JavaScript reads it
  as an identifier and the file fails to parse. Just delete it.
-->

Lab5's `intention_revision.js:437` has a typo:

```js
var plan = await onlineSolver( domain, problem );ù
```

Drop the trailing `ù` when porting — it's a syntax error.

### 1.4 `this.parent` vs `this.#parent`

<!--
  THE STORY
  In modern JS, `#parent` is a private field. You read it as
  `this.#parent` — never `this.parent` (which is undefined and
  silently breaks logging/sub-intentions). Your Agent_1 file is
  already correct here; the warning is so you don't accidentally
  copy Lab5's wrong version on top of yours.
-->

Lab5 line 272 instantiates plans with `new planClass(this.parent)` (broken — `parent` is a private field). Your `Agent_1` copy already uses `this.#parent` correctly. **Keep yours.**

---

## 2. Build a Beliefset of the map

<!--
  WHY THIS STEP?
  A planner can only plan over things it KNOWS about. PDDL needs a
  formal description of the world: "tile 0_0 exists, tile 0_1 exists,
  0_0 is to the left of 1_0, ..." A Beliefset is a tidy container
  for those facts. We build it once, when the server first sends us
  the map, and we keep it in sync as the agent moves.
-->

The PDDL planner needs to know which tiles exist, where deliveries are, and which tiles are adjacent.

### 2.1 Declare the beliefset (after the parcels block, ~line 78)

<!--
  WHAT THIS BLOCK DOES
  Listens once for the `onMap` event (fired by the server right after
  connection). For every tile we declare:
    - that the tile exists,
    - whether it's a delivery tile,
    - which neighbour it has on each of the 4 sides.
  Those four `right/left/up/down` facts are what the planner uses
  later to chain moves together into a route.
-->

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

<!--
  WHY THIS BLOCK?
  The map facts above are STATIC. The agent's own position changes
  every move, so we update it inside `onYou` (which the server fires
  every time the agent's state changes). We:
    1. Declare `me <id>` once (so the planner knows which symbol is "me").
    2. Wipe any old `at me ...` facts.
    3. Declare a fresh `at me X_Y` ONLY if the coordinates are integers
       (during a step they're fractional — the planner can't use them).
-->

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

<!--
  WHY THIS STEP?
  A PDDL "domain" is the rulebook of the world: which actions exist,
  what each action requires, what each action changes. The Lab5 sample
  ships only the `right` action — useless, since you also need to
  go left, up, down. We write the full rulebook once, save it as
  domain-deliveroo.pddl in the same folder, and the planner reads it
  whenever PddlMove asks for a route.
-->

Create **`Agent_1/domain-deliveroo.pddl`** with all four movement actions. Lab5's file (`lab5-APIsForPlanning/domain-deliveroo.pddl`) ships only `right` — you must add the rest.

<!--
  HOW TO READ THE PDDL BELOW
  - :predicates lists the FACTS the planner can talk about.
  - Each :action has:
      :parameters    -> the variables it takes (?me, ?from, ?to)
      :precondition  -> what must already be true to do it
      :effect        -> what becomes true / false afterwards
  All four actions are identical except for the direction predicate
  (right / left / up / down) used in the precondition.
-->

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

<!--
  WHY THIS STEP?
  This is the brain of the upgrade. PddlMove is a "Plan": it knows
  how to fulfil a `['go_to', x, y]` intention. Instead of walking
  one step at a time like BlindMove, it:
    1. Builds a PDDL problem from the current Beliefset.
    2. Asks the online solver for a route ("plan").
    3. Walks the returned actions, calling socket.emitMove() for each.
  If the planner returns nothing, we throw and let the framework fall
  back to the next plan in the library (BlindMove).
-->

Replace Lab5's broken `PddlMove` (`lab5/intention_revision.js:418-445`) with a working version. Add it **after** `BlindMove` in `intention_revision.js`:

```js
class PddlMove extends Plan {

    static isApplicableTo (go_to, x, y) {
        // Only handles 'go_to' intentions; other plans ignore it.
        return go_to === 'go_to';
    }

    async execute (go_to, x, y) {
        if (this.stopped) throw ['stopped'];

        // 1) Build the PDDL problem: objects from the beliefset,
        //    initial state from the beliefset, goal = "be at x_y".
        const pddlProblem = new PddlProblem(
            'deliveroo',
            myBeliefset.objects.join(' '),
            myBeliefset.toPddlString(),
            `at ${me.id} ${x}_${y}`
        );
        const problem = pddlProblem.toPddlString();
        const domain  = await readFile('./domain-deliveroo.pddl', 'utf8');

        // 2) Ask the online solver for a route.
        const plan = await onlineSolver(domain, problem);
        if (!plan) throw ['no_plan_found'];
        if (this.stopped) throw ['stopped'];

        // 3) Execute every step. Each plan step has a `.action` string
        //    matching the action name we declared in the domain.
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

<!--
  WHY THIS STEP?
  The agent's plan-library is an ordered list. When an intention
  arrives, the framework walks the list and runs the first plan
  whose `isApplicableTo` returns true. By inserting PddlMove BEFORE
  BlindMove, we make the planner the default movement strategy and
  keep BlindMove as a backup for when the planner fails (server
  down, weird map, no path found).
-->

At the bottom of `intention_revision.js`, add `PddlMove` **before** `BlindMove` so the planner is tried first and `BlindMove` becomes a fallback:

```js
planLibrary.push( GoPickUp )
planLibrary.push( PddlMove )
planLibrary.push( BlindMove )
```

The `Intention.achieve()` loop already tries plans in order and falls through on error, so a planner failure (no path, server down) will gracefully degrade to greedy movement.

---

## 6. (Recommended) Add delivery — currently the agent never scores

<!--
  WHY THIS STEP?
  In Deliveroo you only earn points by DROPPING parcels on a delivery
  tile. Without this step the agent picks parcels up forever and
  never delivers — its score stays at zero. We need a new option
  type ('go_put_down') and a matching plan (GoPutDown).
-->

Picking up parcels without delivering them never increments `score`. Add a delivery option and plan:

### 6.1 Track carried parcels in `optionsGeneration`

<!--
  WHAT THIS BLOCK DOES
  After listing pickup options, also check: am I carrying anything?
  If yes, find the nearest delivery tile and queue a `go_put_down`
  intention. The intention-revision loop will then prioritise it.
-->

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

<!--
  WHAT THIS BLOCK DOES
  Same shape as GoPickUp: walk to (x,y) via a sub-intention, then
  call socket.emitPutdown(). The sub-intention will be handled by
  PddlMove (or BlindMove fallback), so we don't repeat path code.
-->

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

<!--
  WHY THIS STEP?
  The default revision strategy ("nearest parcel wins") ignores parcel
  VALUE and ignores delivery urgency. A smarter agent ranks options
  by `reward - distance` and always prefers a pending delivery over
  any pickup. This is what `IntentionRevisionRevise` is meant to do —
  it just isn't implemented yet.
-->

`IntentionRevisionRevise` (line 286) is a stub. Replace its `push` with utility-based ordering:

```js
async push (predicate) {
    // Higher utility = better. We sort the queue by it descending.
    const utility = (pred) => {
        const [type, x, y, id] = pred;
        if (type === 'go_pick_up') {
            const p = parcels.get(id);
            if (!p) return -Infinity;          // parcel gone -> ignore
            return p.reward - distance({x, y}, me); // reward minus walk cost
        }
        if (type === 'go_put_down') return 1000; // delivery is always top priority
        return 0;
    };

    const intention = new Intention(this, predicate);
    this.intention_queue.push(intention);
    this.intention_queue.sort((a, b) => utility(b.predicate) - utility(a.predicate));

    // If the new intention is now the best one, stop whatever is currently running.
    if (this.intention_queue[0] !== intention) return;
    const running = this.intention_queue[1];
    if (running) running.stop();
}
```

Switch the active agent to `new IntentionRevisionRevise()` once the utility logic is in.

---

## 8. Run order — how to test each step

<!--
  WHY THIS SECTION?
  Add features one layer at a time and verify each layer works
  before stacking the next. If something breaks, you'll know which
  layer caused it.
-->

1. After **step 1 (bug fixes)**: run `node intention_revision.js`; the agent should still behave like Lab4 (greedy nearest-parcel pick-up) — but the "intention skipping" log line should now actually fire when a parcel is carried by another agent.
2. After **steps 2–5 (PDDL movement)**: watch the console for `at ${me.id} ${x}_${y}` problems being printed and a non-empty `plan` array. The agent should now navigate around obstacles instead of getting stuck on walls.
3. After **step 6 (delivery)**: `me.score` should start increasing.
4. After **step 7 (utility revision)**: the agent should ignore far-but-low-value parcels in favor of close-or-valuable ones, and always prefer delivering when carrying.

---

## 9. Quick checklist

<!--
  Tick these off as you go. When all are ticked, the agent is
  feature-complete for Lab5.
-->

- [ ] Fixed `predicate[2]` → `predicate[3]` (parcel id lookup)
- [ ] Created `domain-deliveroo.pddl` with `right`/`left`/`up`/`down`
- [ ] Added `Beliefset` + `socket.onMap` handler with corrected `find`
- [ ] Sync `at me X_Y` inside `socket.onYou`
- [ ] Added working `PddlMove` plan that drives `socket.emitMove`
- [ ] Pushed `PddlMove` to `planLibrary` before `BlindMove`
- [ ] (Recommended) Added `go_put_down` option + `GoPutDown` plan
- [ ] (Optional) Implemented utility-based `IntentionRevisionRevise`

Once all boxes above are ticked, the agent senses → updates beliefs → generates options → revises intentions → and either plans a path with PDDL or falls back to BlindMove — the full Lab5 control cycle.

<!--
============================================================
  ONE-PARAGRAPH RECAP (read this if you forget everything else)
============================================================
  Lab5 = give the agent a brain that PLANS. You teach the agent the
  shape of the map (Beliefset), the rules of motion (PDDL domain),
  and a new movement Plan (PddlMove) that asks an online solver for
  a route and executes it move-by-move. You keep BlindMove as a
  safety net, you add a delivery Plan so the agent actually scores,
  and (optionally) you let it pick the best intention by utility
  rather than just by distance. Fix the small inherited bugs first,
  then layer the features in the order above.
============================================================
-->
