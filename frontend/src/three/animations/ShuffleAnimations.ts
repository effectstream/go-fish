import * as THREE from 'three';
import gsap from 'gsap';

/**
 * Shuffle animations — loops diverse card-shuffle motions on the deck during
 * Setup so the user sees the scene alive while proofs generate (can take up
 * to ~60s on slow hardware). All variants take an array of `CardHandle`s
 * (the visible deck meshes + their rest poses) and return a Promise that
 * resolves when the variant ends with every card back at its rest pose.
 *
 * The orchestrator {@link startShuffleLoop} picks a non-repeating variant
 * each cycle and chains them until the returned stop-fn is called. Stopping
 * kills in-flight tweens on the deck meshes and settles them to rest so the
 * deal animation can take over cleanly.
 */

export interface CardHandle {
  mesh: THREE.Object3D;
  restPos: THREE.Vector3;
  restRot: THREE.Euler;
}

/** Capture each mesh's current pose so variants know where to return to. */
export function snapshotCards(meshes: THREE.Object3D[]): CardHandle[] {
  return meshes.map((m) => ({
    mesh: m,
    restPos: m.position.clone(),
    restRot: m.rotation.clone(),
  }));
}

function tweenTo(
  mesh: THREE.Object3D,
  pos: THREE.Vector3,
  rot: THREE.Euler,
  duration: number,
  ease = 'power2.inOut',
  delay = 0,
): Promise<void> {
  return new Promise((resolve) => {
    let done = 0;
    const onBoth = () => { if (++done === 2) resolve(); };
    gsap.to(mesh.position, {
      x: pos.x, y: pos.y, z: pos.z,
      duration, ease, delay,
      onComplete: onBoth,
    });
    gsap.to(mesh.rotation, {
      x: rot.x, y: rot.y, z: rot.z,
      duration, ease, delay,
      onComplete: onBoth,
    });
  });
}

async function settleToRest(cards: CardHandle[], duration = 0.35): Promise<void> {
  await Promise.all(
    cards.map((c) => tweenTo(c.mesh, c.restPos, c.restRot, duration, 'power2.out')),
  );
}

function killMeshTweens(cards: CardHandle[]): void {
  for (const c of cards) {
    gsap.killTweensOf(c.mesh.position);
    gsap.killTweensOf(c.mesh.rotation);
    gsap.killTweensOf(c.mesh.scale);
  }
}

/**
 * Riffle: split the deck in half, fan the halves apart, then bring them
 * back together with an interleaved cascade.
 */
async function riffleShuffle(cards: CardHandle[]): Promise<void> {
  if (cards.length < 2) return;
  const half = Math.floor(cards.length / 2);
  const left = cards.slice(0, half);
  const right = cards.slice(half);

  // Split apart laterally
  await Promise.all([
    ...left.map((c, i) => tweenTo(
      c.mesh,
      new THREE.Vector3(c.restPos.x - 0.55, c.restPos.y + i * 0.002, c.restPos.z - 0.15),
      new THREE.Euler(c.restRot.x, c.restRot.y, c.restRot.z - 0.08),
      0.35,
      'power2.out',
    )),
    ...right.map((c, i) => tweenTo(
      c.mesh,
      new THREE.Vector3(c.restPos.x + 0.55, c.restPos.y + i * 0.002, c.restPos.z - 0.15),
      new THREE.Euler(c.restRot.x, c.restRot.y, c.restRot.z + 0.08),
      0.35,
      'power2.out',
    )),
  ]);

  // Interleave back with a staggered snap
  const interleaved: Array<Promise<void>> = [];
  const stagger = 0.06;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i]) {
      interleaved.push(tweenTo(
        left[i].mesh, left[i].restPos, left[i].restRot,
        0.25, 'power3.out', i * stagger,
      ));
    }
    if (right[i]) {
      interleaved.push(tweenTo(
        right[i].mesh, right[i].restPos, right[i].restRot,
        0.25, 'power3.out', i * stagger + stagger / 2,
      ));
    }
  }
  await Promise.all(interleaved);
}

/**
 * Overhand: lift the top ~⅓ of the deck straight up, drop it back, repeat
 * with a slightly different chunk size.
 */
async function overhandShuffle(cards: CardHandle[]): Promise<void> {
  if (cards.length < 3) return;
  const iters = 3;
  for (let k = 0; k < iters; k++) {
    const chunkSize = Math.max(2, Math.floor(cards.length * (0.25 + Math.random() * 0.25)));
    const top = cards.slice(-chunkSize);

    // Lift
    await Promise.all(top.map((c) => tweenTo(
      c.mesh,
      new THREE.Vector3(c.restPos.x, c.restPos.y + 0.8, c.restPos.z + 0.1),
      new THREE.Euler(c.restRot.x, c.restRot.y, c.restRot.z),
      0.25,
      'power2.out',
    )));

    // Drop with overshoot (bounce)
    await Promise.all(top.map((c, i) => new Promise<void>((resolve) => {
      gsap.to(c.mesh.position, {
        x: c.restPos.x, y: c.restPos.y, z: c.restPos.z,
        duration: 0.35,
        ease: 'bounce.out',
        delay: i * 0.01,
        onComplete: resolve,
      });
    })));
  }
}

/**
 * Cascade: bow the stack into a waterfall — cards tilt forward and slide
 * outward in an arc, then slide back.
 */
async function cascadeShuffle(cards: CardHandle[]): Promise<void> {
  if (cards.length < 2) return;
  const n = cards.length;
  // Arc out: each card moves to a position along a rightward arc.
  await Promise.all(cards.map((c, i) => {
    const t = n === 1 ? 0 : i / (n - 1);
    const arcX = (t - 0.5) * 1.4;
    const arcZ = -Math.abs(t - 0.5) * 0.4;
    const arcY = c.restPos.y + 0.15 + Math.sin(t * Math.PI) * 0.25;
    return tweenTo(
      c.mesh,
      new THREE.Vector3(c.restPos.x + arcX, arcY, c.restPos.z + arcZ),
      new THREE.Euler(c.restRot.x, c.restRot.y, c.restRot.z + (t - 0.5) * 0.3),
      0.55,
      'power2.out',
      i * 0.03,
    );
  }));

  // Hold briefly so the arc reads.
  await new Promise<void>((r) => setTimeout(r, 200));

  // Gather back.
  await Promise.all(cards.map((c, i) => tweenTo(
    c.mesh, c.restPos, c.restRot,
    0.45, 'power3.inOut', i * 0.02,
  )));
}

/**
 * Table spread: fan the deck out flat across the table, then sweep back.
 */
async function tableSpreadShuffle(cards: CardHandle[]): Promise<void> {
  if (cards.length < 2) return;
  const n = cards.length;
  const spread = 1.6;

  // Fan out (no vertical motion — sliding across the table).
  await Promise.all(cards.map((c, i) => {
    const t = n === 1 ? 0 : (i / (n - 1)) * 2 - 1; // -1..1
    return tweenTo(
      c.mesh,
      new THREE.Vector3(c.restPos.x + t * spread, c.restPos.y, c.restPos.z + Math.abs(t) * 0.25),
      new THREE.Euler(c.restRot.x, c.restRot.y, c.restRot.z + t * 0.25),
      0.55,
      'power2.out',
      i * 0.02,
    );
  }));

  await new Promise<void>((r) => setTimeout(r, 350));

  // Sweep back into stack.
  await Promise.all(cards.map((c, i) => tweenTo(
    c.mesh, c.restPos, c.restRot,
    0.45, 'power3.inOut',
    // Reverse the stagger so outer cards come in first — feels like a sweep.
    (n - i) * 0.015,
  )));
}

/**
 * Hindu: the top card flies off, arcs over, and lands on the bottom. Repeats
 * 4 times so 4 different cards take the trip in sequence.
 */
async function hinduShuffle(cards: CardHandle[]): Promise<void> {
  if (cards.length < 3) return;
  const iters = Math.min(4, cards.length - 1);
  for (let k = 0; k < iters; k++) {
    // Top card = highest in stack (last in array, per Deck3D layout).
    const top = cards[cards.length - 1 - k] ?? cards[cards.length - 1];

    // Lift + arc forward+right.
    const apex = new THREE.Vector3(
      top.restPos.x + 0.8, top.restPos.y + 0.7, top.restPos.z + 0.3,
    );
    await tweenTo(
      top.mesh, apex,
      new THREE.Euler(top.restRot.x, top.restRot.y + 0.4, top.restRot.z - 0.3),
      0.3, 'power2.out',
    );

    // Land back on stack (same rest pose — visually we're cycling but meshes
    // keep their identities; the motion is what sells the shuffle).
    await tweenTo(
      top.mesh, top.restPos, top.restRot,
      0.3, 'power2.in',
    );
  }
}

const VARIANTS = [
  riffleShuffle,
  overhandShuffle,
  cascadeShuffle,
  tableSpreadShuffle,
  hinduShuffle,
];

/**
 * Start a looping shuffle animation on the provided deck cards. Returns a
 * stop fn that kills any in-flight tween and settles every card back to its
 * captured rest pose (≤350ms). Safe to call the stop fn multiple times.
 *
 * Respects `prefers-reduced-motion`: when set, runs a single slow cascade
 * and then stops — no variant cycling.
 */
export function startShuffleLoop(meshes: THREE.Object3D[]): () => Promise<void> {
  const cards = snapshotCards(meshes);
  if (cards.length === 0) {
    return async () => {};
  }

  const reducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  let running = true;
  let stopResolver: (() => void) | null = null;
  const stopped = new Promise<void>((r) => { stopResolver = r; });

  const run = async () => {
    if (reducedMotion) {
      try { await cascadeShuffle(cards); } catch { /* interrupted */ }
      killMeshTweens(cards);
      await settleToRest(cards);
      stopResolver?.();
      return;
    }

    let lastIdx = -1;
    while (running) {
      let idx = Math.floor(Math.random() * VARIANTS.length);
      if (idx === lastIdx && VARIANTS.length > 1) {
        idx = (idx + 1) % VARIANTS.length;
      }
      lastIdx = idx;
      try {
        await VARIANTS[idx](cards);
      } catch {
        // Tween was killed (stop() called mid-flight). Exit the loop.
        break;
      }
      if (!running) break;
      // Brief breath between variants so the motion doesn't feel frantic.
      await new Promise<void>((r) => setTimeout(r, 220));
    }
    killMeshTweens(cards);
    await settleToRest(cards);
    stopResolver?.();
  };

  void run();

  return async () => {
    running = false;
    killMeshTweens(cards);
    await stopped;
  };
}
