/**
 * Card Component - SVG card rendering for Go Fish
 */

import type { Card, Rank, Suit } from '../../../shared/data-types/src/go-fish-types';

export class CardComponent {
  /**
   * Render a card as SVG
   */
  static render(card: Card, faceUp: boolean = true): string {
    if (!faceUp) {
      return this.renderCardBack();
    }

    const color = this.getCardColor(card.suit);
    const suitSymbol = this.getSuitSymbol(card.suit);

    return `
      <svg class="card" viewBox="0 0 100 140" xmlns="http://www.w3.org/2000/svg">
        <!-- Card background -->
        <rect x="2" y="2" width="96" height="136" rx="8" fill="white" stroke="#333" stroke-width="2"/>

        <!-- Top left rank and suit -->
        <text x="10" y="25" font-size="20" font-weight="bold" fill="${color}">${card.rank}</text>
        <text x="10" y="45" font-size="16" fill="${color}">${suitSymbol}</text>

        <!-- Center suit (large) -->
        <text x="50" y="85" font-size="48" fill="${color}" text-anchor="middle">${suitSymbol}</text>

        <!-- Bottom right rank and suit (rotated) -->
        <g transform="rotate(180 50 70)">
          <text x="10" y="25" font-size="20" font-weight="bold" fill="${color}">${card.rank}</text>
          <text x="10" y="45" font-size="16" fill="${color}">${suitSymbol}</text>
        </g>
      </svg>
    `;
  }

  /**
   * Render card back (for hidden cards)
   */
  static renderCardBack(): string {
    return `
      <svg class="card card-back" viewBox="0 0 100 140" xmlns="http://www.w3.org/2000/svg">
        <!-- Card background -->
        <rect x="2" y="2" width="96" height="136" rx="8" fill="#1a472a" stroke="#333" stroke-width="2"/>

        <!-- Pattern -->
        <pattern id="card-pattern" x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse">
          <circle cx="10" cy="10" r="2" fill="#2d6b3f"/>
        </pattern>
        <rect x="10" y="10" width="80" height="120" rx="4" fill="url(#card-pattern)"/>

        <!-- Border decoration -->
        <rect x="10" y="10" width="80" height="120" rx="4" fill="none" stroke="#2d6b3f" stroke-width="2"/>
        <rect x="15" y="15" width="70" height="110" rx="4" fill="none" stroke="#2d6b3f" stroke-width="1"/>
      </svg>
    `;
  }

  /**
   * Render a clickable card
   */
  static renderClickable(card: Card, faceUp: boolean = true, onClick?: string): string {
    const cardSvg = faceUp ? this.render(card, faceUp) : this.renderCardBack();
    const clickHandler = onClick ? `onclick="${onClick}"` : '';

    return `
      <div class="card-wrapper" ${clickHandler} data-rank="${card.rank}" data-suit="${card.suit}">
        ${cardSvg}
      </div>
    `;
  }

  /**
   * Render multiple cards in a hand
   */
  static renderHand(cards: Card[], faceUp: boolean = true, clickable: boolean = false): string {
    return `
      <div class="card-hand ${clickable ? 'clickable' : ''}">
        ${cards.map(card => {
          if (clickable) {
            return this.renderClickable(card, faceUp, `this.parentElement.dispatchEvent(new CustomEvent('card-click', { detail: { rank: '${card.rank}', suit: '${card.suit}' }, bubbles: true }))`);
          } else {
            return `<div class="card-wrapper">${this.render(card, faceUp)}</div>`;
          }
        }).join('')}
      </div>
    `;
  }

  /**
   * Render a book (completed set of 4)
   */
  static renderBook(rank: Rank): string {
    return `
      <div class="book">
        <div class="book-rank">${rank}</div>
        <div class="book-label">Book</div>
      </div>
    `;
  }

  /**
   * Get card color based on suit
   */
  private static getCardColor(suit: Suit): string {
    return suit === 'hearts' || suit === 'diamonds' ? '#dc2626' : '#1f2937';
  }

  /**
   * Get suit symbol
   */
  private static getSuitSymbol(suit: Suit): string {
    const symbols: Record<Suit, string> = {
      hearts: '♥',
      diamonds: '♦',
      clubs: '♣',
      spades: '♠',
    };
    return symbols[suit];
  }
}
