import * as THREE from 'three';
import type { Card } from '../../../../packages/shared/data-types/src/go-fish-types';
import { Card3D } from './Card3D';
import type { CardTextureAtlas } from '../textures/CardTextureAtlas';

// Horizontal spacing between cards. Card width is 1.0 world units, so anything
// below 1.0 causes overlap (intentional fan look for larger hands). For small
// hands we widen the spread so cards don't stack.
const FAN_SPREAD_TIGHT = 0.9;   // Used when hand has 4+ cards (fan overlap)
const FAN_SPREAD_WIDE = 1.15;   // Used when hand has <= 3 cards (no overlap)
const FAN_ARC = 0.03;       // Vertical arc curvature
const FAN_TILT = 0.02;      // Rotation tilt per card from center

/**
 * A fan layout of Card3D objects representing a player's hand.
 * Cards are arranged in a slight arc at the bottom of the table.
 */
export class CardHand {
  readonly group: THREE.Group;
  private cards: Card3D[] = [];
  private atlas: CardTextureAtlas;

  constructor(atlas: CardTextureAtlas) {
    this.group = new THREE.Group();
    this.atlas = atlas;
  }

  /** Replace the entire hand with new cards. */
  setCards(cards: Card[]): void {
    this.clear();
    for (const card of cards) {
      const card3d = new Card3D(card, this.atlas, true);
      this.cards.push(card3d);
      this.group.add(card3d.mesh);
    }
    this.layoutCards();
  }

  /** Get all Card3D instances (for raycaster hit testing). */
  getCards(): Card3D[] {
    return this.cards;
  }

  /**
   * Remove matching cards from the hand WITHOUT disposing them. Returns the
   * extracted Card3D instances so the caller can animate them out (e.g. when
   * a card is lost to an opponent). The hand is NOT re-laid-out here — call
   * {@link setCards} next to replace the full list, which will lay out the
   * remaining cards into their new positions.
   *
   * After detaching, the Card3D meshes are still children of `this.group`.
   * Callers that want to animate them independently of the hand should call
   * `scene.attach(card.mesh)` to reparent while preserving world transform.
   */
  detachCards(predicate: (card: Card) => boolean): Card3D[] {
    const detached: Card3D[] = [];
    const kept: Card3D[] = [];
    for (const c of this.cards) {
      if (predicate(c.card)) {
        detached.push(c);
      } else {
        kept.push(c);
      }
    }
    this.cards = kept;
    return detached;
  }

  private layoutCards(): void {
    const count = this.cards.length;
    if (count === 0) return;

    const spread = count <= 3 ? FAN_SPREAD_WIDE : FAN_SPREAD_TIGHT;
    const totalWidth = (count - 1) * spread;
    const startX = -totalWidth / 2;

    for (let i = 0; i < count; i++) {
      const card3d = this.cards[i];
      const t = count > 1 ? (i / (count - 1)) * 2 - 1 : 0; // -1 to 1

      const x = startX + i * spread;
      const y = 0.05 + i * 0.001; // Slight stacking so cards overlap correctly
      const z = -t * t * FAN_ARC * count; // Subtle arc

      const position = new THREE.Vector3(x, y, z);
      const rotation = new THREE.Euler(0, 0, -t * FAN_TILT);

      card3d.setRestPose(position, rotation);
    }
  }

  clear(): void {
    for (const card of this.cards) {
      this.group.remove(card.mesh);
      card.dispose();
    }
    this.cards = [];
  }

  dispose(): void {
    this.clear();
  }
}
