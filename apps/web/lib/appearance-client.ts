'use client';
import { appearanceAttributes, themeStylesheet, type Appearance } from '@crew/contracts';

const MANAGED = ['data-preset', 'data-theme', 'data-density', 'data-motion', 'data-radius', 'data-font', 'data-contrast', 'data-table', 'data-sidebar-style', 'data-focus'];

/** Applies an appearance to the live page without a reload: theme stylesheet plus attributes on <html>. */
export function applyAppearance(a: Appearance) {
  const root = document.documentElement;
  const attrs = appearanceAttributes(a);
  for (const name of MANAGED) {
    if (attrs[name] === undefined) root.removeAttribute(name);
    else root.setAttribute(name, attrs[name]!);
  }
  let style = document.getElementById('crew-theme') as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = 'crew-theme';
    document.head.appendChild(style);
  }
  style.textContent = themeStylesheet(a);
}
