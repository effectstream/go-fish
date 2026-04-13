import * as THREE from 'three';
import gsap from 'gsap';
import type { Card3D } from '../objects/Card3D';

/**
 * Card animation utilities using gsap for smooth, Balatro-style motion.
 */

/** Deal a card from a source position (deck) to a target position with a flip. */
export function animateDeal(
  card: Card3D,
  from: THREE.Vector3,
  to: THREE.Vector3,
  delay: number = 0,
  duration: number = 0.5,
): Promise<void> {
  return new Promise((resolve) => {
    // Start at source position
    card.mesh.position.copy(from);
    card.mesh.scale.setScalar(0.5);

    const tl = gsap.timeline({ delay, onComplete: resolve });

    // Move to target
    tl.to(card.mesh.position, {
      x: to.x,
      y: to.y + 0.8, // Arc up
      z: to.z,
      duration: duration * 0.6,
      ease: 'power2.out',
    });

    // Settle down to final position
    tl.to(card.mesh.position, {
      y: to.y,
      duration: duration * 0.4,
      ease: 'bounce.out',
    });

    // Scale up simultaneously
    tl.to(card.mesh.scale, {
      x: 1, y: 1, z: 1,
      duration: duration * 0.6,
      ease: 'power2.out',
    }, 0); // Start at same time as move

    // Flip rotation (rotate on the card mesh's local axis)
    const cardMesh = card.mesh.children[0]; // The card body mesh
    if (cardMesh) {
      tl.fromTo(cardMesh.rotation, {
        y: Math.PI,
      }, {
        y: 0,
        duration: duration * 0.5,
        ease: 'power2.inOut',
      }, delay > 0 ? 0 : duration * 0.2);
    }
  });
}

/** Draw a single card from the deck to the player's hand. */
export function animateDrawFromDeck(
  card: Card3D,
  deckPosition: THREE.Vector3,
  handPosition: THREE.Vector3,
  duration: number = 0.6,
): Promise<void> {
  return new Promise((resolve) => {
    card.mesh.position.copy(deckPosition);
    card.mesh.scale.setScalar(1);

    const tl = gsap.timeline({ onComplete: resolve });

    // Lift from deck
    tl.to(card.mesh.position, {
      y: deckPosition.y + 1.0,
      duration: duration * 0.25,
      ease: 'power2.out',
    });

    // Slide to hand position
    tl.to(card.mesh.position, {
      x: handPosition.x,
      y: handPosition.y + 0.5,
      z: handPosition.z,
      duration: duration * 0.5,
      ease: 'power2.inOut',
    });

    // Settle into hand
    tl.to(card.mesh.position, {
      y: handPosition.y,
      duration: duration * 0.25,
      ease: 'power1.out',
    });

    // Flip during slide
    const cardMesh = card.mesh.children[0];
    if (cardMesh) {
      tl.fromTo(cardMesh.rotation, {
        y: Math.PI,
      }, {
        y: 0,
        duration: duration * 0.4,
        ease: 'power2.inOut',
      }, duration * 0.2);
    }
  });
}

/** Transfer a card from one position to another (e.g., opponent to player). */
export function animateTransfer(
  card: Card3D,
  from: THREE.Vector3,
  to: THREE.Vector3,
  duration: number = 0.7,
): Promise<void> {
  return new Promise((resolve) => {
    card.mesh.position.copy(from);

    gsap.to(card.mesh.position, {
      x: to.x,
      y: to.y,
      z: to.z,
      duration,
      ease: 'power2.inOut',
      onComplete: resolve,
    });
  });
}

/** Book completion celebration — cards gather and flash. */
export function animateBookComplete(
  cards: Card3D[],
  targetPosition: THREE.Vector3,
  duration: number = 0.8,
): Promise<void> {
  return new Promise((resolve) => {
    const tl = gsap.timeline({ onComplete: resolve });

    // Gather all cards to center
    for (const card of cards) {
      tl.to(card.mesh.position, {
        x: targetPosition.x,
        y: targetPosition.y + 0.5,
        z: targetPosition.z,
        duration: duration * 0.5,
        ease: 'power2.in',
      }, 0);

      tl.to(card.mesh.scale, {
        x: 1.2, y: 1.2, z: 1.2,
        duration: duration * 0.3,
        ease: 'power2.out',
      }, duration * 0.3);
    }

    // Flash and shrink
    for (const card of cards) {
      tl.to(card.mesh.scale, {
        x: 0.01, y: 0.01, z: 0.01,
        duration: duration * 0.3,
        ease: 'power2.in',
      }, duration * 0.6);
    }
  });
}

/** Staggered deal of multiple cards from deck to hand positions. */
export function animateDealHand(
  cards: Card3D[],
  deckPosition: THREE.Vector3,
  staggerDelay: number = 0.15,
): Promise<void> {
  const promises = cards.map((card, i) => {
    const targetPos = card.mesh.position.clone();
    return animateDeal(card, deckPosition, targetPos, i * staggerDelay);
  });
  return Promise.all(promises).then(() => {});
}
