import {
  Activity, Banknote, BarChart3, Bell, BookOpen, Bot, Briefcase, Building, Building2, CalendarClock, CalendarDays, CalendarRange, Check, ClipboardList, Clock,
  Contact, CreditCard, FileStack, FileText, Fingerprint, GraduationCap, Handshake, Headset, Heart, Home, Inbox, KeyRound, Landmark, LifeBuoy, ListChecks,
  LockKeyhole, Mail, Megaphone, MessageSquare, MessagesSquare, Orbit, Palette, Plug, Receipt, ScrollText, Settings, Shield, SlidersHorizontal, Sparkles, Tags,
  Target, Timer, TrendingDown, UserPlus, Users, UserSearch, UsersRound, UserX, Wallet, Workflow, X, type LucideIcon,
} from 'lucide-react';

/** Icon names used by navigation, quick actions and overview tiles, so the API and nav can name icons as strings. */
export const ICONS: Record<string, LucideIcon> = {
  home: Home, users: Users, building: Building2, shield: Shield, scroll: ScrollText, 'credit-card': CreditCard, settings: Settings, 'life-buoy': LifeBuoy, key: KeyRound,
  inbox: Inbox, calendar: CalendarDays, 'list-checks': ListChecks, contact: Contact, sliders: SlidersHorizontal,
  clock: Clock, 'calendar-clock': CalendarClock, 'users-round': UsersRound, timer: Timer, fingerprint: Fingerprint,
  briefcase: Briefcase, 'user-search': UserSearch, 'message-square': MessageSquare,
  'file-text': FileText, receipt: Receipt, wallet: Wallet, banknote: Banknote, landmark: Landmark,
  target: Target, 'messages-square': MessagesSquare, 'graduation-cap': GraduationCap, 'clipboard-list': ClipboardList, heart: Heart,
  'calendar-range': CalendarRange, 'book-open': BookOpen, chart: BarChart3,
  headset: Headset, megaphone: Megaphone,
  activity: Activity, bot: Bot, plug: Plug, sparkles: Sparkles, 'trending-down': TrendingDown, workflow: Workflow,
  'lock-keyhole': LockKeyhole, mail: Mail, 'user-x': UserX, palette: Palette, 'user-plus': UserPlus,
  handshake: Handshake, 'building-office': Building, 'file-stack': FileStack, orbit: Orbit, tags: Tags,
  check: Check, x: X, bell: Bell,
};
