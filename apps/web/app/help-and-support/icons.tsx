'use client';
import type { HelpIcon } from '@crew/contracts';
import {
  Activity, ChartColumn, BookOpen, Briefcase, Building2, CalendarDays, SquareCheck, Clock, CreditCard, FileText, Globe, GraduationCap, Handshake, Headset,
  Heart, House, Inbox, KeyRound, Laptop, Megaphone, MessagesSquare, Network, Plug, Receipt, Rocket, ScrollText, Settings, Shield, Smartphone, Sparkles,
  Tag, Target, ToggleRight, Upload, User, Users, Wallet, Wrench, type LucideIcon,
} from 'lucide-react';

/** The line icon for each help icon key, for the public Help & Support page. */
export const ICONS: Record<HelpIcon, LucideIcon> = {
  rocket: Rocket, user: User, shield: Shield, home: House, inbox: Inbox, messages: MessagesSquare, megaphone: Megaphone, users: Users,
  network: Network, toggle: ToggleRight, clock: Clock, calendar: CalendarDays, wallet: Wallet, receipt: Receipt, briefcase: Briefcase,
  handshake: Handshake, target: Target, graduation: GraduationCap, heart: Heart, file: FileText, laptop: Laptop, checklist: SquareCheck,
  chart: ChartColumn, sparkles: Sparkles, scroll: ScrollText, card: CreditCard, settings: Settings, phone: Smartphone, headset: Headset, wrench: Wrench,
  building: Building2, tag: Tag, key: KeyRound, activity: Activity, plug: Plug, globe: Globe, book: BookOpen, upload: Upload,
};

export function HelpLineIcon({ icon, className }: { icon: string; className?: string }) {
  const Icon = ICONS[icon as HelpIcon] ?? Sparkles;
  return <Icon className={className} aria-hidden />;
}
