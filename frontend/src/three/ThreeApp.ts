import * as THREE from 'three';
import gsap from 'gsap';
import { Table } from './objects/Table';
import { CardTextureAtlas } from './textures/CardTextureAtlas';
import { CardHand } from './objects/CardHand';
import { Deck3D } from './objects/Deck3D';
import { OpponentHand } from './objects/OpponentHand';
import { InputManager } from './InputManager';
import { createPostProcessing } from './effects/PostProcessing';
import { animateDeal, animateTransfer, animateCardLeave } from './animations/CardAnimations';
import { startShuffleLoop } from './animations/ShuffleAnimations';
import type { EffectComposer } from 'postprocessing';
import type { Card } from '../../../packages/shared/data-types/src/go-fish-types';

/**
 * Root Three.js application — creates renderer, scene, camera, lights, and render loop.
 * Designed to render behind the existing DOM UI (coexistence mode).
 */
export class ThreeApp {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly clock: THREE.Clock;
  readonly atlas: CardTextureAtlas;
  readonly inputManager: InputManager;

  private table: Table;
  private playerHand: CardHand;
  private opponentHand: OpponentHand;
  private deck: Deck3D;
  private composer: EffectComposer;
  private animationFrameId: number | null = null;
  private canvasContainer: HTMLElement;

  /** Current drawable width — the container's innerWidth, not window's,
   *  so the canvas shrinks when the side panel takes space on desktop. */
  private get viewportWidth(): number { return this.canvasContainer.clientWidth || window.innerWidth; }
  private get viewportHeight(): number { return this.canvasContainer.clientHeight || window.innerHeight; }

  constructor(container: HTMLElement) {
    this.canvasContainer = container;
    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.viewportWidth, this.viewportHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a2e);

    // Camera — looking down at the table at ~45 degrees
    this.camera = new THREE.PerspectiveCamera(
      45,
      this.viewportWidth / this.viewportHeight,
      0.1,
      100,
    );
    this.camera.position.set(0, 10, 12);
    this.camera.lookAt(0, 0, 0);

    // Lights
    this.setupLights();

    // Table
    this.table = new Table();
    this.scene.add(this.table.mesh);

    // Card textures
    this.atlas = new CardTextureAtlas();
    this.atlas.generateAll();

    // Player hand — positioned at front of table
    this.playerHand = new CardHand(this.atlas);
    this.playerHand.group.position.set(0, 0.15, 3.5);
    this.scene.add(this.playerHand.group);

    // Opponent hand — positioned at back of table
    this.opponentHand = new OpponentHand(this.atlas);
    this.opponentHand.group.position.set(0, 0.15, -3.5);
    this.scene.add(this.opponentHand.group);

    // Deck — center of table
    this.deck = new Deck3D(this.atlas);
    this.deck.mesh.position.set(0, 0.15, 0);
    this.scene.add(this.deck.mesh);

    // Input manager for card interaction
    this.inputManager = new InputManager(this.camera, this.renderer.domElement);
    // Enable pointer events on the canvas for hover detection
    this.renderer.domElement.style.pointerEvents = 'auto';

    // Post-processing
    this.composer = createPostProcessing(this.renderer, this.scene, this.camera);

    // Clock
    this.clock = new THREE.Clock();

    // Resize handling
    window.addEventListener('resize', this.onResize);

    // Show a demo scene with sample cards
    this.showDemoScene();
  }

  /** Display sample cards so the scene isn't empty during coexistence mode.
   *  Kicks off the idle demo loop — random card add/remove + deck shifts so
   *  the scene always looks like *something* is happening. */
  private showDemoScene(): void {
    const demoCards: Card[] = [
      { rank: 'A', suit: 'hearts' },
      { rank: '3', suit: 'diamonds' },
      { rank: '5', suit: 'clubs' },
      { rank: '7', suit: 'hearts' },
    ];

    this.playerHand.setCards(demoCards);
    this.inputManager.setInteractiveCards(this.playerHand.getCards());

    this.opponentHand.setCardCount(4);
    this.opponentHand.setName('');

    this.deck.setCount(13);

    this.startIdleAnimation();
  }

  // ───────── Idle / "demo table" animation ─────────

  private idleIntervalId: number | null = null;

  /** Begin randomly mutating the demo scene every ~1.8-3.5s (add a card,
   *  remove a card, swap a card, nudge opponent count, shift deck). Runs
   *  until `stopIdleAnimation()` is called (typically when a real game
   *  scene takes over). */
  startIdleAnimation(): void {
    if (this.idleIntervalId !== null) return;
    const tick = () => {
      this.mutateDemoScene();
      const delay = 1800 + Math.random() * 1700;
      this.idleIntervalId = window.setTimeout(tick, delay);
    };
    this.idleIntervalId = window.setTimeout(tick, 1500);
  }

  stopIdleAnimation(): void {
    if (this.idleIntervalId !== null) {
      clearTimeout(this.idleIntervalId);
      this.idleIntervalId = null;
    }
  }

  private mutateDemoScene(): void {
    const RANKS: Array<Card['rank']> = ['A', '2', '3', '4', '5', '6', '7'];
    const SUITS: Array<Card['suit']> = ['hearts', 'diamonds', 'clubs'];
    const randCard = (): Card => ({
      rank: RANKS[Math.floor(Math.random() * RANKS.length)]!,
      suit: SUITS[Math.floor(Math.random() * SUITS.length)]!,
    });

    // Compute deck position in hand-local coords (for animation source/target)
    const deckWorld = new THREE.Vector3();
    this.deck.mesh.getWorldPosition(deckWorld);
    const handGroup = this.playerHand.group;
    const deckLocal = handGroup.worldToLocal(deckWorld.clone());

    const currentHand = this.playerHand.getCards().map(c => c.card);
    // Weighted actions:
    //   40% add a card from deck (up to 6)
    //   35% send a card back to deck (down to 1)
    //   20% swap one card (no deck animation, just a flip)
    //   5%  full reshuffle
    const roll = Math.random();

    if (roll < 0.40 && currentHand.length < 6) {
      // ADD — setCards first so the new Card3D is created at its rest pose,
      // then replay the deal animation on JUST the new card, from the deck.
      const newCard = randCard();
      const next = [...currentHand, newCard];
      this.playerHand.setCards(next);
      this.inputManager.setInteractiveCards(this.playerHand.getCards());
      const cards3d = this.playerHand.getCards();
      const added = cards3d[cards3d.length - 1];
      if (added) {
        const restPos = added.mesh.position.clone();
        animateDeal(added, deckLocal, restPos, 0, 0.55).catch(() => {});
      }
    } else if (roll < 0.75 && currentHand.length > 1) {
      // REMOVE — two demo variants, picked 50/50 so the idle scene exercises
      // both card-exit animations:
      //   (a) fly-to-deck: the old "discard back into the deck" motion.
      //   (b) leave-hand:  the opponent-takes-your-card arc from
      //       animateCardLoss. Mirrors exactly what happens in a real game
      //       when an ask-hit removes cards from your hand.
      const idx = Math.floor(Math.random() * currentHand.length);
      const cards3d = this.playerHand.getCards();
      const removed = cards3d[idx];
      const removedCard = currentHand[idx]!;
      const next = currentHand.slice(0, idx).concat(currentHand.slice(idx + 1));
      const variant: 'deck' | 'leave' = Math.random() < 0.5 ? 'deck' : 'leave';

      if (removed && variant === 'deck') {
        animateTransfer(removed, removed.mesh.position.clone(), deckLocal, 0.55)
          .then(() => {
            this.playerHand.setCards(next);
            this.inputManager.setInteractiveCards(this.playerHand.getCards());
          })
          .catch(() => {
            this.playerHand.setCards(next);
            this.inputManager.setInteractiveCards(this.playerHand.getCards());
          });
      } else if (removed && variant === 'leave') {
        // Same flow GameScene uses when a real hand update removes cards:
        // detach + arc-out via animateCardLoss, then reset the hand so the
        // remaining cards close the fan immediately.
        this.animateCardLoss([removedCard]);
        this.playerHand.setCards(next);
        this.inputManager.setInteractiveCards(this.playerHand.getCards());
      } else {
        this.playerHand.setCards(next);
        this.inputManager.setInteractiveCards(this.playerHand.getCards());
      }
    } else if (roll < 0.95 && currentHand.length > 0) {
      // SWAP — in-place replace a card; simple re-render (no deck motion).
      const idx = Math.floor(Math.random() * currentHand.length);
      const next = currentHand.slice();
      next[idx] = randCard();
      this.playerHand.setCards(next);
      this.inputManager.setInteractiveCards(this.playerHand.getCards());
    } else {
      // FULL RESHUFFLE — new random hand, dealt-in from the deck.
      const n = 2 + Math.floor(Math.random() * 4); // 2-5 cards
      const next: Card[] = [];
      for (let i = 0; i < n; i++) next.push(randCard());
      this.playerHand.setCards(next);
      this.inputManager.setInteractiveCards(this.playerHand.getCards());
      const cards3d = this.playerHand.getCards();
      for (let i = 0; i < cards3d.length; i++) {
        const c = cards3d[i]!;
        const restPos = c.mesh.position.clone();
        animateDeal(c, deckLocal, restPos, i * 0.08, 0.5).catch(() => {});
      }
    }

    // Opponent count drifts 3..5
    const opp = 3 + Math.floor(Math.random() * 3);
    this.opponentHand.setCardCount(opp);

    // Deck count drifts 8..15
    const deck = 8 + Math.floor(Math.random() * 8);
    this.deck.setCount(deck);
  }

  /** Get the deck group for click targeting. */
  getDeckGroup(): THREE.Group {
    return this.deck.mesh;
  }

  /** Get the opponent hand group for click targeting. */
  getOpponentGroup(): THREE.Group {
    return this.opponentHand.group;
  }

  /** Get the player hand group (for coordinate transforms). */
  getPlayerHandGroup(): THREE.Group {
    return this.playerHand.group;
  }

  /** Get current player Card3D instances (for animations). */
  getPlayerCards(): import('./objects/Card3D').Card3D[] {
    return this.playerHand.getCards();
  }

  /** Update the player's hand from game state. */
  setPlayerHand(cards: Card[]): void {
    this.playerHand.setCards(cards);
    this.inputManager.setInteractiveCards(this.playerHand.getCards());
  }

  /**
   * Animate cards leaving the player's hand (taken by opponent on ask-hit,
   * or flying to a book pile). Detaches the matching Card3D instances from
   * the hand, reparents them to the scene so they survive the next
   * {@link setPlayerHand} call, and runs an independent arc-out tween before
   * disposing.
   *
   * Non-blocking: the caller should still invoke {@link setPlayerHand} with
   * the new hand state immediately so the remaining cards re-layout into
   * the gap without waiting for the animation to finish.
   */
  animateCardLoss(lostCards: Card[]): void {
    if (lostCards.length === 0) return;
    const detached = this.playerHand.detachCards(
      (c) => lostCards.some((l) => l.rank === c.rank && l.suit === c.suit),
    );
    for (const card of detached) {
      card.setInteractive(false);
      // Reparent to the scene, preserving world transform — the next
      // setCards call on the hand would otherwise wipe these meshes via
      // clear().
      this.scene.attach(card.mesh);
      const finish = () => {
        this.scene.remove(card.mesh);
        card.dispose();
      };
      animateCardLeave(card).then(finish).catch(finish);
    }
  }

  /** Update opponent's visible card count. */
  setOpponentCardCount(count: number): void {
    this.opponentHand.setCardCount(count);
  }

  private deckShuffleStopFn: (() => Promise<void>) | null = null;

  /**
   * Begin an indefinite shuffle animation on the deck. If a shuffle is
   * already running, it is torn down first so the new loop captures the
   * current deck meshes (setDeckCount rebuilds them, invalidating the prior
   * snapshot). Used during Setup to keep the scene alive while proofs
   * generate.
   */
  startDeckShuffle(): void {
    if (this.deckShuffleStopFn) {
      const old = this.deckShuffleStopFn;
      this.deckShuffleStopFn = null;
      // Don't await — old tweens target meshes the deck has replaced and
      // don't render anyway. Letting them drain in the background is fine.
      void old();
    }
    const meshes = this.deck.getCardMeshes();
    if (meshes.length === 0) return;
    this.deckShuffleStopFn = startShuffleLoop(meshes);
  }

  /**
   * Halt the shuffle loop. Resolves once the current variant has been killed
   * and every deck mesh has settled back to its rest pose (≤350ms). Safe to
   * call even when no shuffle is running.
   */
  async stopDeckShuffle(): Promise<void> {
    const stop = this.deckShuffleStopFn;
    this.deckShuffleStopFn = null;
    if (stop) await stop();
  }

  /** Update opponent's name. */
  setOpponentName(name: string): void {
    this.opponentHand.setName(name);
  }

  /** Highlight or unhighlight the opponent area (for opponent selection mode). */
  setOpponentHighlighted(highlighted: boolean): void {
    this.opponentHand.setHighlighted(highlighted);
  }

  /** Update deck count. If a deck shuffle is currently running, restart it
   *  so the loop captures the fresh card meshes (Deck3D.setCount disposes
   *  and rebuilds them). */
  setDeckCount(count: number): void {
    const wasShuffling = this.deckShuffleStopFn !== null;
    this.deck.setCount(count);
    if (wasShuffling) this.startDeckShuffle();
  }

  /** Enable or disable pulsing glow on the deck (e.g., during draw phase). */
  setDeckGlowing(glowing: boolean): void {
    this.deck.setGlowing(glowing);
  }

  /** Enable or disable hover animations on player hand cards. */
  setCardsInteractive(interactive: boolean): void {
    const cards = this.playerHand.getCards();
    for (const card of cards) {
      card.setInteractive(interactive);
      // Clear hover state so cards snap back to rest immediately
      if (!interactive) card.setHovered(false);
    }
    // When non-interactive, remove cards from raycaster so the cursor
    // doesn't change and no hover detection runs at all.
    this.inputManager.setInteractiveCards(interactive ? cards : []);
  }

  /** Shake the camera to indicate something impactful (e.g., losing cards). */
  shakeCamera(intensity: number = 0.15, duration: number = 0.5): void {
    const originalPos = this.camera.position.clone();
    const tl = gsap.timeline();

    const shakes = 6;
    const stepDuration = duration / shakes;

    for (let i = 0; i < shakes; i++) {
      const decay = 1 - i / shakes; // Decay over time
      const offsetX = (Math.random() - 0.5) * 2 * intensity * decay;
      const offsetY = (Math.random() - 0.5) * 2 * intensity * decay;

      tl.to(this.camera.position, {
        x: originalPos.x + offsetX,
        y: originalPos.y + offsetY,
        duration: stepDuration,
        ease: 'power1.inOut',
      });
    }

    // Return to original position
    tl.to(this.camera.position, {
      x: originalPos.x,
      y: originalPos.y,
      z: originalPos.z,
      duration: stepDuration,
      ease: 'power2.out',
    });
  }

  /** Spawn celebratory particles (for book completion, etc.). */
  spawnCelebrationParticles(): void {
    const count = 40;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const velocities: THREE.Vector3[] = [];

    const celebrationColors = [
      new THREE.Color(0xffaa00), // Gold
      new THREE.Color(0xff4444), // Red
      new THREE.Color(0x44ff44), // Green
      new THREE.Color(0x4488ff), // Blue
      new THREE.Color(0xff44ff), // Magenta
    ];

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 0.5;
      positions[i * 3 + 1] = 0.5;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 0.5;

      const color = celebrationColors[Math.floor(Math.random() * celebrationColors.length)];
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;

      velocities.push(new THREE.Vector3(
        (Math.random() - 0.5) * 8,
        Math.random() * 6 + 3,
        (Math.random() - 0.5) * 8,
      ));
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 0.15,
      vertexColors: true,
      transparent: true,
      opacity: 1.0,
    });

    const particles = new THREE.Points(geometry, material);
    this.scene.add(particles);

    // Animate particles with gravity
    const startTime = performance.now();
    const duration = 2000;

    const animateParticles = () => {
      const elapsed = performance.now() - startTime;
      if (elapsed > duration) {
        this.scene.remove(particles);
        geometry.dispose();
        material.dispose();
        return;
      }

      const dt = 0.016; // ~60fps step
      const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;

      for (let i = 0; i < count; i++) {
        velocities[i].y -= 9.8 * dt; // gravity
        posAttr.setXYZ(
          i,
          posAttr.getX(i) + velocities[i].x * dt,
          posAttr.getY(i) + velocities[i].y * dt,
          posAttr.getZ(i) + velocities[i].z * dt,
        );
      }
      posAttr.needsUpdate = true;
      material.opacity = 1 - (elapsed / duration);

      requestAnimationFrame(animateParticles);
    };
    requestAnimationFrame(animateParticles);
  }

  private setupLights(): void {
    // Ambient fill
    const ambient = new THREE.AmbientLight(0xfff5e6, 0.4);
    this.scene.add(ambient);

    // Main directional light from above-right
    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(5, 12, 5);
    directional.castShadow = true;
    directional.shadow.mapSize.width = 2048;
    directional.shadow.mapSize.height = 2048;
    directional.shadow.camera.near = 0.5;
    directional.shadow.camera.far = 30;
    directional.shadow.camera.left = -12;
    directional.shadow.camera.right = 12;
    directional.shadow.camera.top = 8;
    directional.shadow.camera.bottom = -8;
    this.scene.add(directional);

    // Warm center point light for atmosphere
    const point = new THREE.PointLight(0xffa060, 0.3, 20);
    point.position.set(0, 4, 0);
    this.scene.add(point);
  }

  start(): void {
    if (this.animationFrameId !== null) return;
    this.animate();
  }

  stop(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  private animate = (): void => {
    this.animationFrameId = requestAnimationFrame(this.animate);
    const _delta = this.clock.getDelta();

    // Update input/hover
    this.inputManager.update();

    // Render with post-processing
    this.composer.render(_delta);
  };

  private onResize = (): void => {
    const w = this.viewportWidth;
    const h = this.viewportHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  };

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    this.inputManager.dispose();
    this.playerHand.dispose();
    this.opponentHand.dispose();
    this.deck.dispose();
    this.table.dispose();
    this.atlas.dispose();
    this.renderer.dispose();
  }
}
