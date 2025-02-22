/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { stringifySelector } from '../../utils/isomorphic/selectorParser';
import type { ParsedSelector } from '../../utils/isomorphic/selectorParser';
import type { InjectedScript } from './injectedScript';
import { asLocator } from '../../utils/isomorphic/locatorGenerators';
import type { Language } from '../../utils/isomorphic/locatorGenerators';
import highlightCSS from './highlight.css?inline';

type HighlightEntry = {
  targetElement: Element,
  highlightElement: HTMLElement,
  tooltipElement?: HTMLElement,
  box?: DOMRect,
  tooltipTop?: number,
  tooltipLeft?: number,
  tooltipText?: string,
};

export type HighlightOptions = {
  tooltipText?: string;
  color?: string;
};

export class Highlight {
  private _glassPaneElement: HTMLElement;
  private _glassPaneShadow: ShadowRoot;
  private _highlightEntries: HighlightEntry[] = [];
  private _actionPointElement: HTMLElement;
  private _isUnderTest: boolean;
  private _injectedScript: InjectedScript;
  private _rafRequest: number | undefined;
  private _language: Language = 'javascript';

  constructor(injectedScript: InjectedScript) {
    this._injectedScript = injectedScript;
    const document = injectedScript.document;
    this._isUnderTest = injectedScript.isUnderTest;
    this._glassPaneElement = document.createElement('x-pw-glass');
    this._glassPaneElement.style.position = 'fixed';
    this._glassPaneElement.style.top = '0';
    this._glassPaneElement.style.right = '0';
    this._glassPaneElement.style.bottom = '0';
    this._glassPaneElement.style.left = '0';
    this._glassPaneElement.style.zIndex = '2147483646';
    this._glassPaneElement.style.pointerEvents = 'none';
    this._glassPaneElement.style.display = 'flex';
    this._glassPaneElement.style.backgroundColor = 'transparent';
    for (const eventName of ['click', 'auxclick', 'dragstart', 'input', 'keydown', 'keyup', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'mousemove', 'mouseleave', 'focus', 'scroll']) {
      this._glassPaneElement.addEventListener(eventName, e => {
        e.stopPropagation();
        e.stopImmediatePropagation();
      });
    }
    this._actionPointElement = document.createElement('x-pw-action-point');
    this._actionPointElement.setAttribute('hidden', 'true');
    this._glassPaneShadow = this._glassPaneElement.attachShadow({ mode: this._isUnderTest ? 'open' : 'closed' });
    this._glassPaneShadow.appendChild(this._actionPointElement);
    const styleElement = document.createElement('style');
    styleElement.textContent = highlightCSS;
    this._glassPaneShadow.appendChild(styleElement);
  }

  install() {
    this._injectedScript.document.documentElement.appendChild(this._glassPaneElement);
  }

  setLanguage(language: Language) {
    this._language = language;
  }

  runHighlightOnRaf(selector: ParsedSelector) {
    if (this._rafRequest)
      cancelAnimationFrame(this._rafRequest);
    this.updateHighlight(this._injectedScript.querySelectorAll(selector, this._injectedScript.document.documentElement), { tooltipText: asLocator(this._language, stringifySelector(selector)) });
    this._rafRequest = requestAnimationFrame(() => this.runHighlightOnRaf(selector));
  }

  uninstall() {
    if (this._rafRequest)
      cancelAnimationFrame(this._rafRequest);
    this._glassPaneElement.remove();
  }

  isInstalled(): boolean {
    return this._glassPaneElement.parentElement === this._injectedScript.document.documentElement && !this._glassPaneElement.nextElementSibling;
  }

  showActionPoint(x: number, y: number) {
    this._actionPointElement.style.top = y + 'px';
    this._actionPointElement.style.left = x + 'px';
    this._actionPointElement.hidden = false;
  }

  hideActionPoint() {
    this._actionPointElement.hidden = true;
  }

  clearHighlight() {
    for (const entry of this._highlightEntries) {
      entry.highlightElement?.remove();
      entry.tooltipElement?.remove();
    }
    this._highlightEntries = [];
  }

  updateHighlight(elements: Element[], options: HighlightOptions) {
    this._innerUpdateHighlight(elements, options);
  }

  maskElements(elements: Element[], color?: string) {
    this._innerUpdateHighlight(elements, { color: color ? color : '#F0F' });
  }

  private _innerUpdateHighlight(elements: Element[], options: HighlightOptions) {
    let color = options.color;
    if (!color)
      color = elements.length > 1 ? '#f6b26b7f' : '#6fa8dc7f';

    // Code below should trigger one layout and leave with the
    // destroyed layout.

    if (this._highlightIsUpToDate(elements, options.tooltipText))
      return;

    // 1. Destroy the layout
    this.clearHighlight();

    for (let i = 0; i < elements.length; ++i) {
      const highlightElement = this._createHighlightElement();
      this._glassPaneShadow.appendChild(highlightElement);

      let tooltipElement;
      if (options.tooltipText) {
        tooltipElement = this._injectedScript.document.createElement('x-pw-tooltip');
        this._glassPaneShadow.appendChild(tooltipElement);
        const suffix = elements.length > 1 ? ` [${i + 1} of ${elements.length}]` : '';
        tooltipElement.textContent = options.tooltipText + suffix;
        tooltipElement.style.top = '0';
        tooltipElement.style.left = '0';
        tooltipElement.style.display = 'flex';
      }
      this._highlightEntries.push({ targetElement: elements[i], tooltipElement, highlightElement, tooltipText: options.tooltipText });
    }

    // 2. Trigger layout while positioning tooltips and computing bounding boxes.
    for (const entry of this._highlightEntries) {
      entry.box = entry.targetElement.getBoundingClientRect();
      if (!entry.tooltipElement)
        continue;

      // Position tooltip, if any.
      const { anchorLeft, anchorTop } = this.tooltipPosition(entry.box, entry.tooltipElement);
      entry.tooltipTop = anchorTop;
      entry.tooltipLeft = anchorLeft;
    }

    // 3. Destroy the layout again.

    // If there are more than 1 box - we are evaluating a non-unique (potentially bad) selector.
    for (const entry of this._highlightEntries) {
      if (entry.tooltipElement) {
        entry.tooltipElement.style.top = entry.tooltipTop + 'px';
        entry.tooltipElement.style.left = entry.tooltipLeft + 'px';
      }
      const box = entry.box!;
      entry.highlightElement.style.backgroundColor = color;
      entry.highlightElement.style.left = box.x + 'px';
      entry.highlightElement.style.top = box.y + 'px';
      entry.highlightElement.style.width = box.width + 'px';
      entry.highlightElement.style.height = box.height + 'px';
      entry.highlightElement.style.display = 'block';

      if (this._isUnderTest)
        console.error('Highlight box for test: ' + JSON.stringify({ x: box.x, y: box.y, width: box.width, height: box.height })); // eslint-disable-line no-console
    }
  }

  firstBox(): DOMRect | undefined {
    return this._highlightEntries[0]?.box;
  }

  tooltipPosition(box: DOMRect, tooltipElement: HTMLElement) {
    const tooltipWidth = tooltipElement.offsetWidth;
    const tooltipHeight = tooltipElement.offsetHeight;
    const totalWidth = this._glassPaneElement.offsetWidth;
    const totalHeight = this._glassPaneElement.offsetHeight;

    let anchorLeft = box.left;
    if (anchorLeft + tooltipWidth > totalWidth - 5)
      anchorLeft = totalWidth - tooltipWidth - 5;
    let anchorTop = box.bottom + 5;
    if (anchorTop + tooltipHeight > totalHeight - 5) {
      // If can't fit below, either position above...
      if (box.top > tooltipHeight + 5) {
        anchorTop = box.top - tooltipHeight - 5;
      } else {
        // Or on top in case of large element
        anchorTop = totalHeight - 5 - tooltipHeight;
      }
    }
    return { anchorLeft, anchorTop };
  }

  private _highlightIsUpToDate(elements: Element[], tooltipText: string | undefined): boolean {
    if (elements.length !== this._highlightEntries.length)
      return false;
    for (let i = 0; i < this._highlightEntries.length; ++i) {
      if (tooltipText !== this._highlightEntries[i].tooltipText)
        return false;
      if (elements[i] !== this._highlightEntries[i].targetElement)
        return false;
      const oldBox = this._highlightEntries[i].box;
      if (!oldBox)
        return false;
      const box = elements[i].getBoundingClientRect();
      if (box.top !== oldBox.top || box.right !== oldBox.right || box.bottom !== oldBox.bottom || box.left !== oldBox.left)
        return false;
    }
    return true;
  }

  private _createHighlightElement(): HTMLElement {
    return this._injectedScript.document.createElement('x-pw-highlight');
  }

  appendChild(element: HTMLElement) {
    this._glassPaneShadow.appendChild(element);
  }
}
