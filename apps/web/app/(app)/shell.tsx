'use client';
import { DEFAULT_APPEARANCE, DELETE_AREAS, FEATURE_ACTION_KEYS, NOTIFICATION_NAV, buildTheme, designLevelOf, presetChoices, workspaceLevelLabel, type Appearance, type AppearancePatch, type MemberPreferences, type WorkView } from '@crew/contracts';
import { AutoHelp, Avatar, Badge, CrewLogo, Dialog, HelpProvider, Kbd, cn } from '@crew/ui';
import {
  Bell, Building2, CalendarDays, Check, ChevronDown, ChevronsUpDown, Contact, CreditCard, Home, Inbox, KeyRound, LifeBuoy, ListChecks, LogOut, Menu, Monitor, Moon, ScrollText, Search,
  Settings, Shield, SlidersHorizontal, Sun, Users, X, Clock, CalendarClock, UsersRound, Timer, Fingerprint, Briefcase, UserSearch, MessageSquare,
  type LucideIcon,
  Banknote, FileText, Landmark, Receipt, Wallet,
  BarChart3, BookOpen, CalendarRange, ClipboardList, GraduationCap, Heart, MessagesSquare, Target,
  Headset, Megaphone,
  Activity, Bot, Plug, Sparkles, TrendingDown, Workflow,
  Lock, LockKeyhole, UserX,
  Palette, UserRound, PanelLeftClose, PanelLeftOpen, Plus, Star, UserPlus, Focus, History, ArrowRight, CornerDownLeft,
  Handshake, Building, FileStack, Tags, Orbit,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useTransition } from 'react';
import { applyAppearance } from '@/lib/appearance-client';
import { photoUrl } from '@/lib/photo';
import { WEB_HELP } from '@/lib/help-content';
import { ICONS } from '@/lib/icons';
import { HOME_VIEW_COOKIE, MY_DAY_HREFS, accountLinks, myDayNav, type HomeViewKey, type NavGroup, type NavItem, type QuickAction } from '@/lib/nav';
import type { Me, Notification } from '@/lib/types';
import { paletteSearchAction, recordSessionLocationAction, recordVisitAction, saveExperienceAction, resetAppearanceAction, saveAppearanceAction, saveFavouritesAction, syncAppearanceCookieAction } from './experience-actions';
import { IqPanel } from './iq-panel';
import { FirstLoginTour } from './first-login-tour';
import { ThemePanel } from './theme-panel';
import { logoutAction, switchTenantAction } from './shell-actions';
import { markCategoryReadAction } from './notifications/actions';
import { NotificationBell } from '@/components/notification-bell';
import { HeaderPunch } from '@/components/header-punch';
import { useOptionalLive } from '@/components/live';
import { FeatureGate } from '@/components/feature-gate';
import { useDesignLevel } from '@/lib/design-level';

export { ICONS };

export interface Notifications { unread: number; items: Notification[] }

// ---------------------------------------------------------------------------------------------------------------
// Appearance and shortcuts, shared with the Theme Studio and Home through context
// ---------------------------------------------------------------------------------------------------------------

interface Experience {
  appearance: Appearance;
  update: (patch: AppearancePatch) => Promise<{ ok: boolean; message?: string }>;
  reset: () => Promise<{ ok: boolean; message?: string }>;
  saving: boolean;
  favourites: string[];
  toggleFavourite: (href: string) => void;
  recents: MemberPreferences['recents'];
  setRecents: (r: MemberPreferences['recents']) => void;
  /** Opens the Themes & Templates panel. */
  openThemes: () => void;
  /** Opens SampCrew IQ when the workspace has it. */
  openAssistant: (() => void) | null;
}
const ExperienceContext = createContext<Experience | null>(null);
export function useExperience() {
  const x = useContext(ExperienceContext);
  if (!x) throw new Error('useExperience outside the app shell');
  return x;
}

function useExperienceState(prefs: MemberPreferences | null, cookieAppearance: Appearance): Omit<Experience, 'openThemes' | 'openAssistant'> {
  const [appearance, setAppearance] = useState<Appearance>(prefs?.appearance ?? cookieAppearance);
  const [favourites, setFavourites] = useState<string[]>(prefs?.favourites ?? []);
  const [recents, setRecents] = useState<MemberPreferences['recents']>(prefs?.recents ?? []);
  const [saving, setSaving] = useState(false);

  // The database copy wins over this browser's cookie copy (for example after changing the theme on another device).
  useEffect(() => {
    if (prefs && JSON.stringify(prefs.appearance) !== JSON.stringify(cookieAppearance)) {
      applyAppearance(prefs.appearance);
      void syncAppearanceCookieAction(prefs.appearance);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Quick changes (Ctrl+B then a click, say) send several saves; only the newest one's answer may set the state,
  // or an older response arriving late would undo what the person just did.
  const latest = useRef(appearance);
  latest.current = appearance;
  const saveSeq = useRef(0);
  const update = useCallback(async (patch: AppearancePatch) => {
    const before = latest.current;
    const next = { ...before, ...patch };
    latest.current = next;
    setAppearance(next);
    applyAppearance(next);
    const id = ++saveSeq.current;
    setSaving(true);
    const r = await saveAppearanceAction(patch);
    if (id !== saveSeq.current) return r.ok ? { ok: true } : { ok: false, message: r.message };
    setSaving(false);
    if (!r.ok) {
      setAppearance(before);
      applyAppearance(before);
      return { ok: false, message: r.message };
    }
    setAppearance(r.data!.appearance);
    applyAppearance(r.data!.appearance);
    return { ok: true };
  }, []);

  const reset = useCallback(async () => {
    setSaving(true);
    const r = await resetAppearanceAction();
    setSaving(false);
    if (!r.ok) return { ok: false, message: r.message };
    setAppearance(r.data!.appearance);
    applyAppearance(r.data!.appearance);
    return { ok: true };
  }, []);

  const favRef = useRef(favourites);
  favRef.current = favourites;
  const toggleFavourite = useCallback((href: string) => {
    const before = favRef.current;
    const next = before.includes(href) ? before.filter((h) => h !== href) : [...before, href].slice(-12);
    setFavourites(next);
    void saveFavouritesAction(next).then((r) => { if (!r.ok) setFavourites(before); });
  }, []);

  return { appearance, update, reset, saving, favourites, toggleFavourite, recents, setRecents };
}

// ---------------------------------------------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------------------------------------------

const isActive = (href: string, pathname: string, allHrefs: string[]) =>
  href === '/' ? pathname === '/' : (pathname === href || pathname.startsWith(`${href}/`)) && !allHrefs.some((h) => h.length > href.length && h.startsWith(`${href}/`) && (pathname === h || pathname.startsWith(`${h}/`)));

export function Shell({ me, nav: fullNav, notifications, prefs, cookieAppearance, counts, quick, workflows, workView: savedView, views, homeView, children }: {
  me: Me;
  /** My Workforce or My Day for people who can switch (issue #86); null for everyone else. */
  workView: WorkView | null;
  /** Home's views (Organization, Workforce, My Day), switched at the top of the sidebar (issue #89). */
  views: { key: HomeViewKey; label: string }[];
  /** The Organization or Workforce view last chosen, when remembered. */
  homeView: 'organization' | 'workforce' | null;
  /** The whole menu; My Day keeps only the person's own pages. */
  nav: NavGroup[];
  notifications: Notifications | null;
  prefs: MemberPreferences | null;
  cookieAppearance: Appearance;
  counts: Record<string, number>;
  quick: QuickAction[];
  workflows: QuickAction[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const live = useOptionalLive();
  // The menu follows My Workforce / My Day as soon as it is switched (issue #89), before the server has saved it.
  const [workView, setWorkView] = useState(savedView);
  useEffect(() => setWorkView(savedView), [savedView]);
  const nav = useMemo(() => (workView === 'myday' ? myDayNav(fullNav) : fullNav), [workView, fullNav]);
  const [themesOpen, setThemesOpen] = useState(false);
  const [iqOpen, setIqOpen] = useState(false);
  const hasIq = me.features.includes('crew_iq');
  // Employee Workspace people change their theme from the account menu (Appearance), so the top bar stays clear.
  const employeeLevel = !me.levels || (!me.levels.super && !me.levels.companyHr && me.levels.hrWorkspaces.length === 0);
  const punchable = Boolean(me.employee) && me.features.includes('attendance_basic') && Boolean(me.permissions['attendance:punch']);
  const state = useExperienceState(prefs, cookieAppearance);
  const openThemes = useCallback(() => setThemesOpen(true), []);
  const openAssistant = useCallback(() => setIqOpen(true), []);
  const experience = useMemo<Experience>(() => ({ ...state, openThemes, openAssistant: hasIq ? openAssistant : null }), [state, openThemes, openAssistant, hasIq]);
  const { appearance, update } = experience;
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const collapsed = appearance.sidebar === 'collapsed';
  const allItems = useMemo(() => nav.flatMap((g) => g.items), [nav]);
  const allHrefs = allItems.map((i) => i.href);
  // Unread notices per module (Leave ●1, Attendance ●5 ...) on the first menu tab this person has for the category,
  // and the total on Notifications, kept live by the stream.
  const hrefKey = allHrefs.join('|');
  const unreadByHref = useMemo(() => {
    const out: Record<string, number> = {};
    const mine = new Set(hrefKey.split('|'));
    for (const [cat, n] of Object.entries(live?.byCategory ?? {})) {
      const href = NOTIFICATION_NAV[cat as keyof typeof NOTIFICATION_NAV]?.find((h) => mine.has(h));
      if (href && n) out[href] = (out[href] ?? 0) + n;
    }
    if (live?.unread) out['/notifications'] = live.unread;
    return out;
  }, [live?.byCategory, live?.unread, hrefKey]);

  // Opening a module counts as seeing its notices, so its menu dot clears (issue #83). Only the categories whose
  // menu entry is the page being opened, and only when they have unread notices.
  const seenRef = useRef('');
  useEffect(() => {
    const mine = new Set(hrefKey.split('|'));
    const cats = Object.entries(live?.byCategory ?? {}).filter(([cat, n]) => {
      const href = NOTIFICATION_NAV[cat as keyof typeof NOTIFICATION_NAV]?.find((h) => mine.has(h));
      return n > 0 && href && (pathname === href || pathname.startsWith(`${href}/`));
    }).map(([cat]) => cat);
    const key = `${pathname}:${cats.join(',')}`;
    if (!cats.length || seenRef.current === key) return;
    seenRef.current = key;
    void Promise.all(cats.map((c) => markCategoryReadAction(c))).then(() => live?.refreshCounts());
  }, [pathname, live, hrefKey]);

  // Where this sign-in happened (issue #86): read once after sign-in when the company reads locations. A refusal is
  // recorded too, so the Activity log says "not shared" and the browser is not asked again in this session.
  const locationPending = Boolean(me.session.locationPending);
  useEffect(() => {
    if (!locationPending) return;
    if (!('geolocation' in navigator)) { void recordSessionLocationAction({ status: 'unavailable' }); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => void recordSessionLocationAction({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracyM: Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : null }),
      (e) => void recordSessionLocationAction({ status: e.code === e.PERMISSION_DENIED ? 'denied' : 'unavailable' }),
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 300_000 },
    );
  }, [locationPending]);

  useEffect(() => setMobileOpen(false), [pathname]);
  // Each level has its own design system (colours, shape, motion): see data-level in @crew/ui styles.css.
  const designLevel = designLevelOf(me.levels);
  useEffect(() => {
    document.documentElement.dataset.level = designLevel;
    return () => { delete document.documentElement.dataset.level; };
  }, [designLevel]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      // Ctrl/Cmd + J opens SampCrew IQ.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j' && hasIq) {
        e.preventDefault();
        setIqOpen((v) => !v);
      }
      // Ctrl/Cmd + . toggles focus mode; Ctrl/Cmd + B toggles the sidebar.
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault();
        void update({ focusMode: !appearance.focusMode });
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target instanceof HTMLElement && e.target.isContentEditable))) {
        // (In the rich-text editor Ctrl+B is bold.)
        e.preventDefault();
        void update({ sidebar: collapsed ? 'expanded' : 'collapsed' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [update, appearance.focusMode, collapsed, hasIq]);

  // Record the page in "recently viewed" once its title has settled.
  const { setRecents } = experience;
  useEffect(() => {
    const t = setTimeout(() => {
      const item = allItems.find((i) => isActive(i.href, pathname, allHrefs));
      const exact = allItems.find((i) => i.href === pathname);
      const title = document.title.replace(/ · SampCrew$/, '').trim();
      const label = (exact?.label ?? (title && title !== 'SampCrew' ? title : item?.label ?? '')).slice(0, 120);
      if (!label || pathname === '/') return;
      const href = pathname + window.location.search;
      void recordVisitAction(href.length <= 200 ? href : pathname, label).then((r) => { if (r.ok) setRecents(r.data!.recents); });
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Feature management, buttons: a button switched off at any level (Console, Super Workspace, HR Workspace) leaves
  // every page it is on. The server refuses its request too; this only keeps it out of sight.
  // Delete permissions: delete buttons of areas the level above has not given this person leave every page (the API
  // refuses those deletes too). Every other delete asks for the password first (DeletePasswordProvider).
  const hiddenActions = useMemo(() => [
    ...FEATURE_ACTION_KEYS.filter((k) => !me.features.includes(k)).map((k) => `[data-feature="${k}"]`),
    ...DELETE_AREAS.filter((a) => !(me.deleteAreas ?? []).includes(a)).map((a) => `[data-delete-area="${a}"]`),
  ].join(','), [me.features, me.deleteAreas]);

  const viewSwitch = views.length > 1 ? <HomeViewSwitch views={views} workView={workView} savedView={savedView} homeView={homeView} pathname={pathname} onWorkView={setWorkView} /> : null;
  const sidebar = (rail: boolean) => <Sidebar me={me} nav={nav} views={rail ? null : viewSwitch} counts={counts} unread={unreadByHref} rail={rail} pathname={pathname} allHrefs={allHrefs} onCollapse={() => void update({ sidebar: rail ? 'expanded' : 'collapsed' })} />;

  return (
    <HelpProvider content={WEB_HELP} pathname={pathname}>
    <ExperienceContext.Provider value={experience}>
      {hiddenActions && <style>{`${hiddenActions}{display:none!important}`}</style>}
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow-pop">Skip to content</a>
      <div className="flex min-h-dvh">
        <aside data-tour="menu" className={cn('crew-glass crew-sidebar sticky top-0 hidden h-dvh shrink-0 border-r border-border transition-[width] duration-200 lg:block', collapsed ? 'w-[4.5rem]' : 'w-64')}>{sidebar(collapsed)}</aside>
        {mobileOpen && (
          <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
            <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
            <aside className="crew-sidebar absolute inset-y-0 left-0 w-72 bg-surface shadow-pop animate-slide-up">
              <button className="absolute right-3 top-4 z-10 rounded-md p-1 text-fg-subtle hover:bg-bg-subtle" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X className="size-4" /></button>
              {sidebar(false)}
            </aside>
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="crew-glass crew-topbar sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border px-3 sm:gap-3 sm:px-6">
            <button className="rounded-md p-1.5 text-fg-muted hover:bg-bg-subtle lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu className="size-5" /></button>
            <button
              onClick={() => setPaletteOpen(true)}
              data-tour="search"
              className="crew-search flex h-9 w-full min-w-9 max-w-md items-center gap-2 rounded-lg border border-border bg-surface/70 px-3 text-[0.8125rem] text-fg-subtle shadow-card transition-colors hover:border-border-strong"
            >
              <Search className="size-4" aria-hidden />
              <span className="hidden flex-1 truncate text-left sm:inline">Search employees, candidates, pages…</span><span className="sr-only sm:hidden">Search</span>
              <span className="hidden sm:inline"><Kbd>Ctrl</Kbd> <Kbd>K</Kbd></span>
            </button>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {/* The top bar keeps only check-in, notifications and theme (issue #83). Approvals, tasks, leave and help
                  live in the sidebar, Create in the search palette, the trial date in the account menu and SampCrew IQ
                  in the bottom-right corner. */}
              {punchable && <HeaderPunch />}
              {notifications && <span data-tour="notifications" className="contents"><NotificationBell /></span>}
              {!employeeLevel && <ThemeMenu />}
              <HeaderUser me={me} />
            </div>
          </header>
          <main id="main" data-tour="home" className="crew-main mx-auto w-full max-w-[1320px] flex-1 px-4 py-6 sm:px-8 sm:py-8"><div key={pathname} className="crew-page"><FeatureGate me={me} pathname={pathname}>{children}</FeatureGate></div></main>
        </div>
        {hasIq && !iqOpen && (
          <button type="button" onClick={() => setIqOpen(true)} aria-expanded={iqOpen} data-testid="iq-launcher" className="crew-ai-button fixed bottom-5 right-5 z-40 inline-flex h-11 items-center gap-2 rounded-full border border-border bg-surface px-4 text-[0.8125rem] font-semibold shadow-card hover:border-accent/50 print:hidden" title="SampCrew IQ, your AI HR assistant (Ctrl+J)">
            <Sparkles className="size-4 text-accent" aria-hidden /><span className="hidden sm:inline">SampCrew IQ</span><span className="sr-only sm:hidden">SampCrew IQ</span>
          </button>
        )}
        {hasIq && <IqPanel open={iqOpen} onClose={() => setIqOpen(false)} />}
        <ThemePanel open={themesOpen} onClose={() => setThemesOpen(false)} appearance={appearance} update={update} />
        {prefs && <FirstLoginTour experience={prefs.experience} canSwitch={views.length > 1} />}
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} nav={nav} me={me} quick={quick} workflows={workflows} />
      </div>
    </ExperienceContext.Provider>
    </HelpProvider>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------------------------------------------

const GROUPS_KEY = 'crew-nav-collapsed';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

function Sidebar({ me, nav, views, counts, unread, rail, pathname, allHrefs, onCollapse }: { me: Me; nav: NavGroup[]; views: React.ReactNode; counts: Record<string, number>; unread: Record<string, number>; rail: boolean; pathname: string; allHrefs: string[]; onCollapse: () => void }) {
  const { favourites, toggleFavourite } = useExperience();
  const uid = useId();
  const [closed, setClosed] = useState<string[]>([]);
  useEffect(() => {
    try { setClosed(JSON.parse(localStorage.getItem(GROUPS_KEY) ?? '[]')); } catch {}
  }, []);
  const toggleGroup = (label: string) => {
    const next = closed.includes(label) ? closed.filter((l) => l !== label) : [...closed, label];
    setClosed(next);
    try { localStorage.setItem(GROUPS_KEY, JSON.stringify(next)); } catch {}
  };
  const byHref = new Map(nav.flatMap((g) => g.items).map((i) => [i.href, i]));
  const favItems = favourites.map((h) => byHref.get(h)).filter((i): i is NavItem => Boolean(i));
  const groups = nav;

  const link = (item: NavItem, key: string, star: boolean) => {
    const Icon = ICONS[item.icon] ?? Home;
    const active = isActive(item.href, pathname, allHrefs);
    const count = counts[item.href];
    const fresh = count ? 0 : (unread[item.href] ?? 0);
    const fav = favourites.includes(item.href);
    return (
      <li key={key} className="group/item relative">
        <Link
          href={item.href}
          aria-current={active ? 'page' : undefined}
          title={rail ? item.label : undefined}
          className={cn(
            'crew-nav-link relative flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[0.84rem] transition-colors duration-150',
            rail && 'justify-center px-0 py-2',
            active ? 'bg-accent-subtle font-medium text-accent' : 'text-fg-muted hover:bg-bg-subtle hover:text-fg',
          )}
        >
          {active && <span className="crew-nav-bar absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent" aria-hidden />}
          <Icon className="size-4 shrink-0" aria-hidden />
          {rail ? <span className="sr-only">{item.label}{item.locked ? ' (not in your plan)' : ''}</span> : <span className="min-w-0 flex-1 truncate">{item.label}</span>}
          {item.locked && !rail && <span className="flex items-center gap-1 text-[0.6875rem] text-fg-muted" data-testid="nav-locked" title="Not in your plan. Upgrade to use this."><Lock className="size-3" aria-hidden /><span className="sr-only">Not in your plan. Upgrade to use this.</span></span>}
          {count ? <span className={cn('rounded-full bg-accent px-1.5 text-[0.625rem] font-semibold leading-4 text-accent-fg tabular', rail && 'absolute right-1 top-0.5')} aria-label={`${count} waiting`}>{count > 99 ? '99+' : count}</span> : null}
          {fresh ? <span data-testid={`nav-unread-${item.href.slice(1).replace(/\//g, '-')}`} className={cn('inline-flex items-center gap-1 text-[0.6875rem] font-semibold text-accent tabular', rail && 'absolute right-1 top-0.5')} aria-label={`${fresh} unread notification${fresh === 1 ? '' : 's'}`}><span aria-hidden className="size-1.5 rounded-full bg-accent" />{rail ? null : fresh > 99 ? '99+' : fresh}</span> : null}
        </Link>
        {star && !rail && !item.locked && (
          <button
            type="button"
            onClick={() => toggleFavourite(item.href)}
            className={cn('absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-fg-subtle opacity-0 hover:text-warning focus:opacity-100 group-hover/item:opacity-100', fav && 'text-warning opacity-100', count && 'right-8')}
            aria-label={fav ? `Remove ${item.label} from favourites` : `Add ${item.label} to favourites`}
            aria-pressed={fav}
          >
            <Star className={cn('size-3', fav && 'fill-current')} />
          </button>
        )}
      </li>
    );
  };

  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-4 px-3 py-4">
      <div className={cn('flex items-center gap-2 px-1', rail && 'flex-col')}>
        {rail ? <CrewLogo withWordmark={false} height={38} /> : <div className="min-w-0 flex-1 px-1"><CrewLogo subtitle="People, simplified." /></div>}
        <button type="button" onClick={onCollapse} className="hidden rounded-md p-1.5 text-fg-subtle hover:bg-bg-subtle hover:text-fg lg:block" aria-label={rail ? 'Expand sidebar' : 'Collapse sidebar'} title={`${rail ? 'Expand' : 'Collapse'} sidebar (Ctrl+B)`}>
          {rail ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </button>
      </div>
      {!rail && <TenantSwitcher me={me} />}
      {/* Organization / Workforce / My Day in place of the old menu filter (issue #89); search is in the top bar (Ctrl K). */}
      {views}
      {/* Favourites stay in place while the rest of the menu scrolls under them. */}
      {favItems.length > 0 && (
        <div className="-mx-1 max-h-56 shrink-0 overflow-y-auto border-b border-border px-1 pb-3" data-testid="nav-favourites">
          {!rail && <div className="flex items-center gap-1.5 px-2 pb-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle"><Star className="size-3" /> Favourites</div>}
          <ul className="flex flex-col gap-0.5" aria-label="Favourites">{favItems.map((i) => link(i, `fav-${i.href}`, false))}</ul>
        </div>
      )}
      <div className="-mx-1 flex flex-1 flex-col gap-3 overflow-y-auto px-1">
        {groups.map((g) => {
          const open = rail || !closed.includes(g.label);
          return (
            <div key={g.label}>
              {!rail ? (
                <div className="flex items-center gap-0.5 pb-1">
                  <button type="button" onClick={() => toggleGroup(g.label)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-1 rounded px-2 text-left text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle hover:text-fg">
                    <span id={`${uid}-${slug(g.label)}`} className="flex-1">{g.label}</span>
                    <ChevronDown className={cn('size-3 transition-transform duration-150', !open && '-rotate-90')} aria-hidden />
                  </button>
                  <AutoHelp kind="module" text={g.label} describedBy={`${uid}-${slug(g.label)}`} className="-mr-1 scale-90" />
                </div>
              ) : <div className="mx-3 mb-1 border-t border-border" aria-hidden />}
              {open && <ul className="flex flex-col gap-0.5">{g.items.map((i) => link(i, i.href, true))}</ul>}
            </div>
          );
        })}
      </div>
      {!rail && <UpgradeCard me={me} />}
      {/* The person's name and account menu live top right only (issue #86), not in the bottom-left corner. */}
    </nav>
  );
}

/** Shown in the neon sidebar to people who can see billing, when a higher plan exists. Links to the real plans page. */
function UpgradeCard({ me }: { me: Me }) {
  if (!me.permissions['billing:read'] || !me.subscription || me.subscription.plan === 'enterprise') return null;
  return (
    <Link href="/settings/billing" className="crew-upgrade mx-1 rounded-xl border border-border bg-bg-subtle p-3 text-[0.8125rem] hover:border-border-strong">
      <span className="flex items-center gap-1.5 font-semibold text-fg"><Sparkles className="size-4 text-warning" aria-hidden /> Upgrade your plan</span>
      <span className="mt-0.5 block text-[0.75rem] text-fg-muted">You are on {me.subscription.plan[0]!.toUpperCase()}{me.subscription.plan.slice(1)}. Compare plans and features.</span>
    </Link>
  );
}

/** Greeting chip on the right of the top bar; opens the member's account menu. */
function HeaderUser({ me }: { me: Me }) {
  const level = workspaceLevelLabel(me.levels);
  return (
    <div className="ml-1 flex shrink-0 flex-col items-end gap-0.5" data-tour="account">
      <AccountMenu me={me} wrapperClassName="shrink-0" buttonClassName="flex items-center whitespace-nowrap gap-2.5 rounded-full py-1 pl-1 pr-3 hover:bg-bg-subtle" testId="account-menu-header">
        <Avatar name={me.user.fullName} size={32} src={me.employee ? photoUrl(me.employee) : null} />
        <span className="hidden flex-col text-left leading-tight sm:flex">
          <span className="text-[0.8125rem] font-semibold">Hi, {me.user.fullName.split(' ')[0]}</span>
          <span className="text-[0.6875rem] text-fg-subtle">{level}</span>
        </span>
      </AccountMenu>
    </div>
  );
}

/**
 * The views at the top of the sidebar (issue #89): the Super Workspace's Organization and Workforce (Home's views,
 * moved here from Home), and My Workforce / My Day for people who look after a workforce (moved here from the top bar,
 * issue #86). My Day keeps only the person's own work and settings in the menu and on Home, in its own colour; the
 * menu changes at once, and the choice is saved for the next visit.
 */
function HomeViewSwitch({ views, workView, savedView, homeView, pathname, onWorkView }: {
  views: { key: HomeViewKey; label: string }[]; workView: WorkView | null; savedView: WorkView | null; homeView: 'organization' | 'workforce' | null;
  pathname: string; onWorkView: (v: WorkView) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const firstOther = views.find((v) => v.key !== 'myday')?.key as 'organization' | 'workforce' | undefined;
  const [home, setHome] = useState<'organization' | 'workforce' | undefined>(homeView ?? firstOther);
  // Home's address says which view it shows (a link to /?view=workforce, say): the switch follows it.
  useEffect(() => {
    if (pathname !== '/') return;
    const v = new URLSearchParams(window.location.search).get('view');
    if (v === 'organization' || v === 'workforce') setHome(v);
  }, [pathname]);
  const current: HomeViewKey = workView === 'myday' ? 'myday' : (views.some((v) => v.key === home) ? home! : firstOther ?? 'workforce');
  const hasOrganization = views.some((v) => v.key === 'organization');
  const choose = (next: HomeViewKey) => {
    if (next === current || pending) return;
    const nextWork: WorkView = next === 'myday' ? 'myday' : 'workforce';
    if (next !== 'myday') {
      setHome(next);
      document.cookie = `${HOME_VIEW_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    }
    const workChanges = workView !== null && nextWork !== workView;
    if (workChanges) {
      onWorkView(nextWork);
      document.documentElement.dataset.view = nextWork;
    }
    start(async () => {
      if (workChanges) {
        const r = await saveExperienceAction({ workView: nextWork }, true);
        if (!r.ok) { onWorkView(savedView ?? 'workforce'); document.documentElement.dataset.view = savedView ?? 'workforce'; return; }
      }
      if (next === 'myday') { if (!MY_DAY_HREFS.has(window.location.pathname)) router.push('/'); }
      // Organization and Workforce are Home's views: open Home with the one chosen.
      else if (hasOrganization || pathname === '/') router.push(`/?view=${next}`);
      if (workChanges) router.refresh();
    });
  };
  return (
    <div role="radiogroup" aria-label="View" data-tour="view" data-testid="work-view-switch" className="mx-1 flex rounded-lg border border-border bg-bg-subtle p-0.5 text-[0.75rem] font-medium">
      {views.map((v) => (
        <button
          key={v.key}
          type="button"
          role="radio"
          aria-checked={current === v.key}
          disabled={pending}
          onClick={() => choose(v.key)}
          data-testid={`work-view-${v.key}`}
          className={cn('min-w-0 flex-1 truncate rounded-md px-2 py-1 leading-4 transition-colors', current === v.key ? 'bg-accent text-accent-fg shadow-card' : 'text-fg-muted hover:text-fg')}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

const ACCOUNT_ICONS: Record<string, LucideIcon> = { profile: UserRound, settings: Settings, activity: History, security: KeyRound, appearance: Palette };

/** The member's own pages (profile, password and sign-in, appearance) and sign out, behind their avatar. */
function AccountMenu({ me, children, wrapperClassName, buttonClassName, up, testId }: { me: Me; children: React.ReactNode; wrapperClassName?: string; buttonClassName?: string; up?: boolean; testId?: string }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className={cn('relative', wrapperClassName)}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="menu" title="Your account" data-testid={testId} className={buttonClassName}>
        {children}
        {/* Named after its visible content plus this, so the accessible name keeps the visible text. */}
        <span className="sr-only">Your account</span>
      </button>
      <Popover open={open} onClose={close} up={up} className="w-56 p-1">
        <div className="border-b border-border px-2.5 pb-2 pt-1.5">
          <div className="truncate text-[0.8125rem] font-medium">{me.user.fullName}</div>
          <div className="truncate text-[0.6875rem] text-fg-subtle">{me.user.email}</div>
          {me.subscription?.status === 'trialing' && me.subscription.trialEndsOn && (
            <Link href="/settings/billing" onClick={close} className="mt-1.5 inline-flex" data-testid="account-trial">
              <Badge tone="info">{me.subscription.plan[0]!.toUpperCase()}{me.subscription.plan.slice(1)} plan · Trial until {new Date(me.subscription.trialEndsOn).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</Badge>
            </Link>
          )}
        </div>
        <ul role="menu" aria-label="Your account" className="pt-1">
          {accountLinks(me).map((a) => {
            const Icon = ACCOUNT_ICONS[a.key] ?? UserRound;
            return (
              <li key={a.key} role="none">
                <Link role="menuitem" href={a.href} onClick={close} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[0.8125rem] text-fg-muted hover:bg-bg-subtle hover:text-fg">
                  <Icon className="size-4 text-accent" /> {a.label}
                </Link>
              </li>
            );
          })}
          <li role="none"><CompactViewItem /></li>
          <li role="none">
            <button role="menuitem" type="button" disabled={pending} onClick={() => start(() => logoutAction())} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[0.8125rem] text-fg-muted hover:bg-bg-subtle hover:text-fg">
              <LogOut className="size-4 text-accent" /> Sign out
            </button>
          </li>
        </ul>
      </Popover>
    </div>
  );
}

/**
 * Compact view (issue #86): smaller text, tighter spacing and tables and a wider page, so more cards and information
 * fit on the screen. Saved with the person's appearance, so it follows them to every device.
 */
function CompactViewItem() {
  const { appearance, update } = useExperience();
  const on = appearance.density === 'compact' && appearance.fontSize === 'small';
  return (
    <button
      role="menuitemcheckbox"
      aria-checked={on}
      type="button"
      data-testid="compact-view"
      onClick={() => void update(on ? { density: 'comfortable', fontSize: 'default', tableDensity: 'comfortable' } : { density: 'compact', fontSize: 'small', tableDensity: 'compact' })}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[0.8125rem] text-fg-muted hover:bg-bg-subtle hover:text-fg"
    >
      <SlidersHorizontal className="size-4 text-accent" /> <span className="flex-1">Compact view</span>
      <span className={cn('relative h-4 w-7 rounded-full transition-colors', on ? 'bg-accent' : 'bg-border-strong')} aria-hidden>
        <span className={cn('absolute top-0.5 size-3 rounded-full bg-white transition-all', on ? 'left-3.5' : 'left-0.5')} />
      </span>
    </button>
  );
}

function TenantSwitcher({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const multiple = me.tenants.length > 1;
  return (
    <div className="relative px-1">
      <button
        disabled={!multiple}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-bg-subtle/60 px-2.5 py-2 text-left disabled:cursor-default"
        aria-haspopup={multiple ? 'listbox' : undefined}
        aria-expanded={multiple ? open : undefined}
      >
        <span className="flex size-7 items-center justify-center rounded-md bg-gradient-to-br from-glow-1 to-glow-2 text-[0.6875rem] font-bold text-white">{me.tenant.name.slice(0, 2).toUpperCase()}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.8125rem] font-medium">{me.tenant.name}</span>
          <span className="block truncate text-[0.6875rem] text-fg-subtle">{me.subscription ? `${me.subscription.plan[0]!.toUpperCase()}${me.subscription.plan.slice(1)} plan` : 'No subscription'}</span>
        </span>
        {multiple && <ChevronsUpDown className="size-4 text-fg-subtle" />}
      </button>
      {open && (
        <ul role="listbox" className="absolute inset-x-1 top-full z-50 mt-1 rounded-lg border border-border bg-surface-raised p-1 shadow-pop animate-fade-in">
          {me.tenants.map((t) => (
            <li key={t.id}>
              <button
                role="option"
                aria-selected={t.id === me.tenant.id}
                disabled={pending}
                onClick={() => (t.id === me.tenant.id ? setOpen(false) : start(async () => void (await switchTenantAction(t.id))))}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.8125rem] hover:bg-bg-subtle"
              >
                <span className="flex-1 truncate">{t.name}</span>
                {t.id === me.tenant.id && <Check className="size-4 text-accent" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Top bar menus
// ---------------------------------------------------------------------------------------------------------------

function Popover({ open, onClose, children, className, up }: { open: boolean; onClose: () => void; children: React.ReactNode; className?: string; up?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className={cn('absolute z-50 rounded-xl border border-border bg-surface-raised shadow-pop animate-fade-in', up ? 'bottom-full left-0 mb-2' : 'right-0 top-full mt-2', className)}>{children}</div>
    </>
  );
}

/** Swatch showing a preset's own colours, independent of the current theme. */
export function PresetSwatch({ preset, mode, size = 'sm' }: { preset: string; mode: 'light' | 'dark'; size?: 'sm' | 'lg' }) {
  const t = buildTheme({ ...DEFAULT_APPEARANCE, preset: preset as Appearance['preset'] }, mode, useDesignLevel());
  return (
    <span className={cn('relative inline-flex overflow-hidden rounded-full border border-border', size === 'sm' ? 'size-5' : 'size-8')} style={{ background: t.bg }} aria-hidden>
      <span className="absolute inset-0" style={{ background: `conic-gradient(from 200deg, ${t['glow-1']}, ${t['glow-2']}, ${t['glow-3']}, ${t['glow-1']})`, clipPath: 'polygon(50% 0, 100% 0, 100% 100%, 50% 100%)' }} />
    </span>
  );
}

function ThemeMenu() {
  const { appearance, update, openThemes } = useExperience();
  const designLevel = useDesignLevel();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ModeIcon = appearance.mode === 'light' ? Sun : appearance.mode === 'dark' ? Moon : Monitor;
  const systemDark = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const swatchMode = appearance.mode === 'system' ? (systemDark ? 'dark' : 'light') : appearance.mode;
  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className="rounded-md p-2 text-fg-muted hover:bg-bg-subtle hover:text-fg" aria-label={`Theme: ${appearance.mode}. Change theme`} aria-expanded={open} title="Theme and appearance">
        <ModeIcon className="size-4" />
      </button>
      <Popover open={open} onClose={close} className="w-72 p-3">
        <div className="mb-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle">Mode</div>
        <div className="mb-3 grid grid-cols-3 gap-1 rounded-lg bg-bg-subtle p-1" role="radiogroup" aria-label="Colour mode">
          {([['light', 'Light', Sun], ['dark', 'Dark', Moon], ['system', 'System', Monitor]] as const).map(([m, label, Icon]) => (
            <button key={m} role="radio" aria-checked={appearance.mode === m} onClick={() => void update({ mode: m })} className={cn('flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium', appearance.mode === m ? 'bg-surface text-fg shadow-card' : 'text-fg-muted hover:text-fg')}>
              <Icon className="size-3.5" /> {label}
            </button>
          ))}
        </div>
        <div className="mb-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle">Theme</div>
        <div className="mb-3 grid grid-cols-6 gap-1.5" role="radiogroup" aria-label="Theme preset">
          {presetChoices(designLevel).map((p) => (
            <button key={p.key} role="radio" aria-checked={appearance.preset === p.key} aria-label={p.name} title={p.name} onClick={() => void update({ preset: p.key })} className={cn('flex items-center justify-center rounded-lg p-1 ring-offset-2 ring-offset-surface-raised', appearance.preset === p.key ? 'ring-2 ring-accent' : 'hover:bg-bg-subtle')}>
              <PresetSwatch preset={p.key} mode={swatchMode} size="lg" />
            </button>
          ))}
        </div>
        <button onClick={() => void update({ focusMode: !appearance.focusMode })} aria-pressed={appearance.focusMode} className="mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[0.8125rem] hover:bg-bg-subtle">
          <Focus className="size-4 text-accent" /> <span className="flex-1">Focus mode</span>
          <span className={cn('h-4 w-7 rounded-full p-0.5 transition-colors', appearance.focusMode ? 'bg-accent' : 'bg-border-strong')}><span className={cn('block size-3 rounded-full bg-white transition-transform', appearance.focusMode && 'translate-x-3')} /></span>
        </button>
        <button type="button" onClick={() => { close(); openThemes(); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[0.8125rem] font-medium text-accent hover:bg-bg-subtle">
          <Palette className="size-4" /> <span className="flex-1">Themes &amp; Templates</span> <ArrowRight className="size-3.5" />
        </button>
        <Link href="/settings/appearance" onClick={close} className="flex items-center gap-2 rounded-lg px-2 py-2 text-[0.8125rem] text-fg-muted hover:bg-bg-subtle hover:text-fg">
          <SlidersHorizontal className="size-4" /> <span className="flex-1">Open Theme Studio</span> <ArrowRight className="size-3.5" />
        </Link>
      </Popover>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Command palette
// ---------------------------------------------------------------------------------------------------------------

interface PaletteItem { id: string; section: string; label: string; detail?: string | null; icon: LucideIcon; run: () => void; keywords?: string }

function CommandPalette({ open, onClose, nav, me, quick, workflows }: { open: boolean; onClose: () => void; nav: NavGroup[]; me: Me; quick: QuickAction[]; workflows: QuickAction[] }) {
  const router = useRouter();
  const { appearance, update, recents } = useExperience();
  const designLevel = useDesignLevel();
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const [hits, setHits] = useState<Awaited<ReturnType<typeof paletteSearchAction>>>([]);
  const [searching, setSearching] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // The dialog focuses its first control (Close) when it opens; move focus to the search box instead.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);
  const sources = useMemo(() => ({ employees: Boolean(me.permissions['employees:read']), candidates: Boolean(me.permissions['candidates:read']) && me.features.includes('recruitment') }), [me]);

  useEffect(() => {
    if (open) { setQ(''); setIndex(0); setHits([]); }
  }, [open]);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2 || (!sources.employees && !sources.candidates)) { setHits([]); return; }
    setSearching(true);
    const t = setTimeout(() => {
      void paletteSearchAction(term, sources).then((h) => { setHits(h); setSearching(false); });
    }, 220);
    return () => clearTimeout(t);
  }, [q, sources]);

  const go = useCallback((href: string) => { onClose(); router.push(href); }, [onClose, router]);
  const items = useMemo<PaletteItem[]>(() => {
    const term = q.trim().toLowerCase();
    const match = (...s: (string | null | undefined)[]) => !term || s.some((x) => x?.toLowerCase().includes(term));
    const out: PaletteItem[] = [];
    for (const a of [...quick, ...workflows]) if (match(a.label, a.keywords)) out.push({ id: `a-${a.key}`, section: 'Actions', label: a.label, icon: ICONS[a.icon] ?? ArrowRight, run: () => go(a.href) });
    for (const h of hits) out.push({ id: `h-${h.kind}-${h.id}`, section: h.kind === 'employee' ? 'People' : 'Candidates', label: h.title, detail: h.detail, icon: h.kind === 'employee' ? Contact : UserSearch, run: () => go(h.href) });
    if (!term) for (const r of recents.slice(0, 5)) out.push({ id: `r-${r.href}`, section: 'Recently viewed', label: r.label, icon: History, run: () => go(r.href) });
    for (const g of nav) for (const i of g.items) if (match(i.label, g.label)) out.push({ id: `p-${i.href}`, section: 'Pages', label: i.label, detail: g.label, icon: ICONS[i.icon] ?? Home, run: () => go(i.href) });
    const themeCmds: PaletteItem[] = [
      { id: 't-dark', section: 'Appearance', label: 'Switch to dark mode', icon: Moon, run: () => { void update({ mode: 'dark' }); onClose(); } },
      { id: 't-light', section: 'Appearance', label: 'Switch to light mode', icon: Sun, run: () => { void update({ mode: 'light' }); onClose(); } },
      { id: 't-focus', section: 'Appearance', label: appearance.focusMode ? 'Turn focus mode off' : 'Turn focus mode on', icon: Focus, run: () => { void update({ focusMode: !appearance.focusMode }); onClose(); } },
      ...presetChoices(designLevel).map((p) => ({ id: `t-${p.key}`, section: 'Appearance', label: `Theme: ${p.name}`, detail: p.description, icon: Palette, run: () => { void update({ preset: p.key }); onClose(); } })),
    ];
    if (term) for (const c of themeCmds) if (match(c.label, c.detail, 'theme appearance')) out.push(c);
    return out;
  }, [q, quick, workflows, hits, recents, nav, appearance.focusMode, update, go, onClose]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  let lastSection = '';
  return (
    <Dialog open={open} onClose={onClose} title="Search SampCrew" size="lg">
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <input
          ref={inputRef}
          autoFocus
          value={q}
          onChange={(e) => { setQ(e.target.value); setIndex(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, items.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
            if (e.key === 'Enter' && items[index]) items[index].run();
          }}
          placeholder="Type a name, a page or an action, for example “approve leave”"
          aria-label="Search pages"
          role="combobox"
          aria-expanded="true"
          aria-controls="crew-palette-list"
          className="h-11 w-full rounded-lg border border-border bg-surface pl-9 pr-3 text-sm focus:border-accent focus:outline-none"
        />
      </div>
      <ul id="crew-palette-list" ref={listRef} className="flex max-h-[24rem] flex-col gap-0.5 overflow-y-auto" role="listbox" aria-label="Results">
        {items.map((i, n) => {
          const header = i.section !== lastSection ? i.section : null;
          lastSection = i.section;
          return (
            <li key={i.id} role="none">
              {header && <div className="px-2.5 pb-1 pt-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle" role="presentation">{header}</div>}
              <button
                role="option"
                aria-selected={n === index}
                onMouseEnter={() => setIndex(n)}
                onClick={i.run}
                className={cn('flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm', n === index ? 'bg-accent-subtle text-accent' : 'text-fg-muted')}
              >
                <i.icon className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{i.label}</span>
                {i.detail && <span className="truncate text-xs text-fg-subtle">{i.detail}</span>}
                {n === index && <CornerDownLeft className="size-3.5 shrink-0" aria-hidden />}
              </button>
            </li>
          );
        })}
        {!items.length && <li className="px-2.5 py-6 text-center text-sm text-fg-subtle">{searching ? 'Searching…' : 'No matching pages, people or actions'}</li>}
      </ul>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3 text-[0.6875rem] text-fg-subtle">
        <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> to move</span><span><Kbd>Enter</Kbd> to open</span><span><Kbd>Ctrl</Kbd> <Kbd>.</Kbd> focus mode</span><span><Kbd>Ctrl</Kbd> <Kbd>B</Kbd> sidebar</span>
      </div>
    </Dialog>
  );
}
