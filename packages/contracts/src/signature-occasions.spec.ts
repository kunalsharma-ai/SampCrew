import { describe, expect, it } from 'vitest';
import { type CompanyBanner, easterSunday, OCCASIONS, occasionByKey, occasionDay, occasionWindow, pickBanner, signatureBannerInput, signatureWishesInput, todayIn } from './signature-occasions';
import { renderSignature, SAMPLE_SIGNATURE, type SignatureData } from './signatures';

const data: SignatureData = { ...SAMPLE_SIGNATURE, brandColor: '#1F3A93', accentColor: '#E8833A', font: 'Arial', size: 'medium' };
const company = (over: Partial<CompanyBanner>): CompanyBanner => ({
  id: 'b1', occasionKey: null, title: 'Launch', message: 'We are launching!', icon: '🚀', bgColor: '#111111', fgColor: '#FFFFFF', linkUrl: null,
  startsOn: '2026-11-01', endsOn: '2026-11-30', position: 'below', enabled: true, image: null, ...over,
});

describe('festival and celebration wishes', () => {
  it('has a library with unique keys and a date for this year and the next two', () => {
    expect(new Set(OCCASIONS.map((o) => o.key)).size).toBe(OCCASIONS.length);
    expect(OCCASIONS.length).toBeGreaterThanOrEqual(30);
    for (const o of OCCASIONS) for (const y of [2026, 2027, 2028]) expect(occasionDay(o, y), `${o.key} ${y}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('works out dates that move each year', () => {
    expect(easterSunday(2026)).toBe('2026-04-05');
    expect(easterSunday(2027)).toBe('2027-03-28');
    expect(occasionDay(occasionByKey('thanksgiving')!, 2026)).toBe('2026-11-26');
    expect(occasionDay(occasionByKey('mothers-day')!, 2026)).toBe('2026-05-10');
    expect(occasionDay(occasionByKey('fathers-day')!, 2026)).toBe('2026-06-21');
    expect(occasionDay(occasionByKey('diwali')!, 2026)).toBe('2026-11-08');
  });

  it('shows a wish a few days before and through the festival, then moves to next year', () => {
    const diwali = occasionByKey('diwali')!;
    expect(occasionWindow(diwali, '2026-11-06')).toEqual({ day: '2026-11-08', from: '2026-11-04', to: '2026-11-10' });
    expect(occasionWindow(diwali, '2026-11-11')?.day).toBe('2027-10-29');
    // New Year shows from late December of the year before.
    expect(occasionWindow(occasionByKey('new-year')!, '2026-12-29')).toMatchObject({ day: '2027-01-01', from: '2026-12-27' });
  });

  it('picks company banners first, then the person\'s own festivals, then their own message', () => {
    const wishes = signatureWishesInput.parse({ occasions: ['diwali'], message: 'Out of office from 20 Dec', icon: '🌴' });
    expect(pickBanner('2026-11-06', [company({})], wishes)?.view.message).toBe('We are launching!');
    expect(pickBanner('2026-11-06', [company({ enabled: false })], wishes)?.source.kind).toBe('occasion');
    expect(pickBanner('2026-11-06', [company({})], { ...wishes, showCompany: false })?.view.message).toContain('Diwali');
    expect(pickBanner('2026-12-01', [company({})], wishes)?.view).toMatchObject({ message: 'Out of office from 20 Dec', icon: '🌴' });
    expect(pickBanner('2026-12-01', [], { ...wishes, from: '2026-12-15' })).toBeNull();
    // A custom company banner wins over a company festival banner on the same day.
    const both = pickBanner('2026-11-06', [company({ id: 'z', occasionKey: 'diwali', startsOn: null, endsOn: null, message: 'Happy Diwali from all of us' }), company({})], wishes);
    expect(both?.view.message).toBe('We are launching!');
    expect(pickBanner('2026-11-09', [company({ occasionKey: 'diwali', startsOn: null, endsOn: null, message: 'Happy Diwali from all of us' })], wishes)?.view.message).toBe('Happy Diwali from all of us');
  });

  it('draws the banner safely for Outlook, as text or as an image', () => {
    const strip = renderSignature('classic', { ...data, banner: { message: '<b>Happy</b> Diwali', icon: '🪔', bgColor: '#B45309', fgColor: '#FFFFFF', linkUrl: 'https://x.example/d' } });
    expect(strip.html).toContain('bgcolor="#B45309"');
    expect(strip.html).toContain('&lt;b&gt;Happy&lt;/b&gt; Diwali');
    expect(strip.html).toContain('href="https://x.example/d"');
    expect(strip.text).toContain('🪔 <b>Happy</b> Diwali');
    const img = renderSignature('classic', { ...data, banner: { message: 'Season', bgColor: '', fgColor: '', imageSrc: 'SampCrew_files/banner.gif', imageWidth: 960, imageHeight: 200, position: 'above' } });
    expect(img.html).toMatch(/<img src="SampCrew_files\/banner.gif" width="480" height="100"/);
    expect(img.body.indexOf('banner.gif')).toBeLessThan(img.body.indexOf('Priya Sharma'));
    const unsafe = renderSignature('classic', { ...data, banner: { message: 'x', bgColor: 'red;x', fgColor: '#fff', linkUrl: 'javascript:alert(1)' } });
    expect(unsafe.html).not.toContain('javascript:');
    expect(unsafe.html).toContain('bgcolor="#1F3A93"');
  });

  it('checks banners people set up', () => {
    expect(signatureBannerInput.safeParse({ title: 'x', message: 'y' }).success).toBe(false);
    expect(signatureBannerInput.safeParse({ title: 'x', message: 'y', occasionKey: 'diwali' }).success).toBe(true);
    expect(signatureBannerInput.safeParse({ title: 'x', message: 'y', startsOn: '2026-12-10', endsOn: '2026-12-01' }).success).toBe(false);
    expect(signatureBannerInput.safeParse({ title: 'x', message: 'y', startsOn: '2026-01-01', endsOn: '2026-12-01' }).success).toBe(false);
    expect(signatureWishesInput.safeParse({ occasions: ['not-a-festival'] }).success).toBe(false);
    expect(todayIn('Asia/Kolkata', new Date('2026-11-06T20:00:00Z'))).toBe('2026-11-07');
  });
});
