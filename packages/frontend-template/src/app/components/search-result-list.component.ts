/**
 * Debounced search input + result rows.
 *
 * The parent owns the actual fetch — this component only emits `query` on
 * a debounced keystroke and `pick(result)` on a row click. Lets the same
 * UI work for both guest "what to request" and (later) host "what to
 * manually queue."
 *
 * Empty / loading / error states are rendered locally so the parent
 * doesn't have to thread spinner CSS through. Set `disabledReason` to a
 * string to lock the input (e.g. "Spotify isn't connected").
 */

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  EventEmitter,
  inject,
  Input,
  Output,
  signal,
  type WritableSignal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { debounceTime, distinctUntilChanged, Subject } from 'rxjs';
import type { SearchResultWire } from '@opendj/frontend';

export type SearchStatus = 'idle' | 'searching' | 'empty' | 'error';

@Component({
  selector: 'app-search-result-list',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="search">
      <label class="search-input">
        <span class="visually-hidden">Search for a track</span>
        <input
          type="search"
          name="searchQuery"
          [ngModel]="queryValue"
          (ngModelChange)="onQueryChange($event)"
          [placeholder]="placeholder"
          [disabled]="!!disabledReason"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
        />
      </label>
      @if (disabledReason) {
        <p class="hint disabled">{{ disabledReason }}</p>
      } @else if (status === 'searching') {
        <p class="hint loading">Searching…</p>
      } @else if (status === 'error' && errorMessage) {
        <p class="hint error">{{ errorMessage }}</p>
      } @else if (status === 'empty' && hasQuery()) {
        <p class="hint empty">No tracks match "{{ query }}".</p>
      } @else if (!hasQuery()) {
        <p class="hint">{{ idleHint }}</p>
      }
      @if (status === 'idle' || status === 'searching') {
        <ul class="results" [attr.aria-busy]="status === 'searching'">
          @for (r of results; track r.trackUri) {
            <li>
              <button type="button" class="row" (click)="pick.emit(r)" [disabled]="busy">
                @if (r.albumArtUrl) {
                  <img class="art" [src]="r.albumArtUrl" alt="" />
                } @else {
                  <span class="art empty" aria-hidden="true">♪</span>
                }
                <span class="meta">
                  <span class="name">{{ r.trackName }}</span>
                  <span class="artist">{{ r.artistName }}</span>
                </span>
                @if (r.durationMs !== null) {
                  <span class="duration">{{ fmt(r.durationMs) }}</span>
                }
              </button>
            </li>
          }
        </ul>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .search {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .search-input {
        display: block;
      }
      .search-input input {
        width: 100%;
        padding: 12px 14px;
        border-radius: 12px;
        border: 1px solid #2c2440;
        background: #0c0a14;
        color: #f3eef9;
        font: inherit;
        font-size: 15px;
      }
      .search-input input:focus {
        outline: 2px solid #a855f7;
        outline-offset: 1px;
      }
      .search-input input:disabled {
        opacity: 0.6;
      }
      .visually-hidden {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
      }
      .hint {
        margin: 0;
        font-size: 12px;
        color: #a294c5;
      }
      .hint.disabled,
      .hint.error {
        color: #fda4af;
      }
      ul.results {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .row {
        width: 100%;
        background: #1a1525;
        border: 1px solid #2c2440;
        border-radius: 12px;
        padding: 8px 12px;
        display: grid;
        grid-template-columns: 40px 1fr auto;
        gap: 12px;
        align-items: center;
        cursor: pointer;
        font: inherit;
        color: inherit;
        text-align: left;
      }
      .row:hover:not(:disabled) {
        border-color: #a855f7;
      }
      .row:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .art {
        width: 40px;
        height: 40px;
        border-radius: 6px;
        object-fit: cover;
        background: #0c0a14;
      }
      .art.empty {
        display: grid;
        place-items: center;
        color: #6e5e8a;
      }
      .meta {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .name {
        font-size: 14px;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .artist {
        font-size: 12px;
        color: #c8b8e9;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .duration {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 11px;
        color: #a294c5;
      }
    `,
  ],
})
export class SearchResultListComponent {
  private readonly destroyRef = inject(DestroyRef);
  private readonly query$ = new Subject<string>();

  @Input() results: ReadonlyArray<SearchResultWire> = [];
  @Input() status: SearchStatus = 'idle';
  @Input() errorMessage: string | null = null;
  @Input() disabledReason: string | null = null;
  @Input() placeholder = 'Search for a song…';
  @Input() idleHint = 'Type a song name, artist, or album.';
  @Input() debounceMs = 250;
  @Input() minQueryLength = 2;
  @Input() busy = false;

  @Output() readonly query = new EventEmitter<string>();
  @Output() readonly pick = new EventEmitter<SearchResultWire>();

  protected readonly queryModel: WritableSignal<string> = signal('');

  /** Two-way ngModel binding helpers. */
  protected get queryValue(): string {
    return this.queryModel();
  }
  protected set queryValue(v: string) {
    this.queryModel.set(v);
  }

  constructor() {
    this.query$
      .pipe(
        debounceTime(this.debounceMs),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((q) => {
        this.query.emit(q);
      });
  }

  protected onQueryChange(next: string): void {
    this.queryModel.set(next);
    if (next.trim().length < this.minQueryLength) {
      this.query.emit('');
      return;
    }
    this.query$.next(next.trim());
  }

  protected hasQuery(): boolean {
    return this.queryModel().trim().length >= this.minQueryLength;
  }

  protected fmt(ms: number): string {
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
}
