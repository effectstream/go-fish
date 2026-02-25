import * as THREE from 'three';
import type { Card3D } from './objects/Card3D';

/**
 * Raycaster-based mouse interaction for hover detection and clicking
 * on cards, deck, and opponent areas.
 */
export class InputManager {
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private mouseNDC = new THREE.Vector2();
  private camera: THREE.Camera;
  private domElement: HTMLElement;

  private hoveredCard: Card3D | null = null;
  private interactiveCards: Card3D[] = [];

  // Deck click support
  private deckHitTarget: THREE.Object3D | null = null;
  private isDeckHovered = false;

  // Opponent click support
  private opponentHitTarget: THREE.Object3D | null = null;
  private isOpponentHovered = false;

  // Opponent selection mode — when active, opponent hover triggers highlight callback
  private _opponentSelectMode = false;

  /** Callback when a card is clicked. */
  onCardClick: ((card: Card3D) => void) | null = null;
  /** Callback when the deck is clicked. */
  onDeckClick: (() => void) | null = null;
  /** Callback when the opponent area is clicked. */
  onOpponentClick: (() => void) | null = null;
  /** Callback when opponent hover state changes (only in opponent-select mode). */
  onOpponentHoverChange: ((hovered: boolean) => void) | null = null;

  constructor(camera: THREE.Camera, domElement: HTMLElement) {
    this.camera = camera;
    this.domElement = domElement;

    domElement.addEventListener('pointermove', this.onPointerMove);
    domElement.addEventListener('pointerdown', this.onPointerDown);
  }

  /** Set the list of cards that can be hovered/clicked. */
  setInteractiveCards(cards: Card3D[]): void {
    this.interactiveCards = cards;
  }

  /** Set the deck group as a click target. */
  setDeckHitTarget(target: THREE.Object3D | null): void {
    this.deckHitTarget = target;
  }

  /** Set the opponent group as a click target. */
  setOpponentHitTarget(target: THREE.Object3D | null): void {
    this.opponentHitTarget = target;
  }

  /** Enable/disable opponent selection mode (makes opponent hoverable with visual feedback). */
  setOpponentSelectMode(active: boolean): void {
    if (this._opponentSelectMode === active) return;
    this._opponentSelectMode = active;
    if (!active && this.isOpponentHovered) {
      this.isOpponentHovered = false;
      this.onOpponentHoverChange?.(false);
    }
  }

  get opponentSelectMode(): boolean { return this._opponentSelectMode; }

  /** Call each frame to update hover states. */
  update(): void {
    this.raycaster.setFromCamera(this.mouse, this.camera);

    // Check card hovers
    let newHovered: Card3D | null = null;
    if (this.interactiveCards.length > 0) {
      const hitTargets = this.interactiveCards.map(c => c.hitTarget);
      const intersects = this.raycaster.intersectObjects(hitTargets, false);

      if (intersects.length > 0) {
        const hitMesh = intersects[0].object;
        newHovered = hitMesh.userData.card3d ?? null;
      }
    }

    if (newHovered !== this.hoveredCard) {
      if (this.hoveredCard) this.hoveredCard.setHovered(false);
      if (newHovered) newHovered.setHovered(true);
      this.hoveredCard = newHovered;
    }

    // Check deck hover
    let deckHovered = false;
    if (this.deckHitTarget && this.onDeckClick) {
      const deckIntersects = this.raycaster.intersectObject(this.deckHitTarget, true);
      deckHovered = deckIntersects.length > 0;
    }
    this.isDeckHovered = deckHovered;

    // Check opponent hover (only when in opponent-select mode or callback is set)
    let oppHovered = false;
    if (this.opponentHitTarget && (this._opponentSelectMode || this.onOpponentClick)) {
      const oppIntersects = this.raycaster.intersectObject(this.opponentHitTarget, true);
      oppHovered = oppIntersects.length > 0;
    }
    if (oppHovered !== this.isOpponentHovered) {
      this.isOpponentHovered = oppHovered;
      if (this._opponentSelectMode) {
        this.onOpponentHoverChange?.(oppHovered);
      }
    }

    // Update cursor
    const isHoveringAnything = newHovered || deckHovered || oppHovered;
    this.domElement.style.cursor = isHoveringAnything ? 'pointer' : '';

    // Update interaction visuals for all cards
    for (const card of this.interactiveCards) {
      card.updateInteraction(card.hovered ? this.mouseNDC : null);
    }
  }

  private onPointerMove = (event: PointerEvent): void => {
    const rect = this.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.mouseNDC.copy(this.mouse);
  };

  private onPointerDown = (_event: PointerEvent): void => {
    // Priority: card click > deck click > opponent click
    if (this.hoveredCard && this.onCardClick) {
      this.onCardClick(this.hoveredCard);
      return;
    }

    if (this.isDeckHovered && this.onDeckClick) {
      this.onDeckClick();
      return;
    }

    if (this.isOpponentHovered && this.onOpponentClick) {
      this.onOpponentClick();
      return;
    }
  };

  dispose(): void {
    this.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
  }
}
