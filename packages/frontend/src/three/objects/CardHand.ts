import * as THREE from 'three';
import type { Card } from '../../../../shared/data-types/src/go-fish-types';
import { Card3D } from './Card3D';
import type { CardTextureAtlas } from '../textures/CardTextureAtlas';

const FAN_SPREAD = 0.9;    // Horizontal spacing between cards
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

  private layoutCards(): void {
    const count = this.cards.length;
    if (count === 0) return;

    const totalWidth = (count - 1) * FAN_SPREAD;
    const startX = -totalWidth / 2;

    for (let i = 0; i < count; i++) {
      const card3d = this.cards[i];
      const t = count > 1 ? (i / (count - 1)) * 2 - 1 : 0; // -1 to 1

      const x = startX + i * FAN_SPREAD;
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
