import { describe, expect, it } from 'vitest';
import { composeSignatureData, renderSignature, SAMPLE_SIGNATURE, saveSignatureInput, SIGNATURE_TEMPLATES, type SignatureData, signatureSettingsInput } from './signatures';

const data: SignatureData = { ...SAMPLE_SIGNATURE, photoSrc: 'SampCrew_files/photo.png', logoSrc: 'SampCrew_files/logo.png', logoWidth: 300, logoHeight: 100, brandColor: '#1F3A93', accentColor: '#E8833A', font: 'Calibri', size: 'medium' };

describe('email signatures', () => {
  it('has 20 designs with unique keys', () => {
    expect(SIGNATURE_TEMPLATES).toHaveLength(20);
    expect(new Set(SIGNATURE_TEMPLATES.map((t) => t.key)).size).toBe(20);
  });

  it.each(SIGNATURE_TEMPLATES.map((t) => t.key))('renders %s with the person, contacts and Outlook-safe markup', (key) => {
    const { html, text } = renderSignature(key, data);
    expect(html).toContain('Priya Sharma');
    expect(html).toContain('charset=utf-8');
    expect(html).not.toMatch(/<script|display:\s*flex|<svg|class=/i);
    // Every image says how big it is, which Outlook needs.
    for (const img of html.match(/<img [^>]*>/g) ?? []) expect(img).toMatch(/width="\d+" height="\d+"/);
    expect(text.split('\r\n')).toContain('Priya Sharma');
    expect(text).toContain('Email: priya.sharma@northwind.example');
  });

  it('escapes what people type and drops unsafe links and images', () => {
    const { html } = renderSignature('classic', {
      ...data,
      fullName: '<script>alert(1)</script> "Q"',
      tagline: '<img src=x onerror=alert(1)>',
      website: 'javascript:alert(1)',
      social: { linkedin: 'javascript:alert(1)' },
      photoSrc: '" onerror="alert(1)',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toMatch(/<img src=x/);
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('onerror="alert');
  });

  it('keeps the logo in proportion and leaves out what is not set', () => {
    const { html } = renderSignature('logo-top', data);
    expect(html).toContain('width="132" height="44"');
    const bare = renderSignature('photo-left', { ...data, photoSrc: null, logoSrc: null, phone: null, mobile: null, social: {}, disclaimer: null, tagline: null });
    expect(bare.html).not.toContain('<img');
    expect(bare.text).not.toContain('Phone');
  });

  it('applies a person\'s own choices over what is on record', () => {
    const base = { fullName: 'Arjun K', designation: 'Operator', department: 'Assembly', company: 'Northwind', email: 'a@n.example', phone: '+91 20 1', mobile: '+91 98 2',
      website: 'https://n.example', address: 'Pune', disclaimer: 'Confidential', social: { linkedin: 'https://linkedin.com/company/n' }, brandColor: '#111111', accentColor: '#222222', logoWidth: 300, logoHeight: 100 };
    const plain = composeSignatureData(base, saveSignatureInput.parse({ template: 'classic', options: {} }).options);
    expect(plain).toMatchObject({ jobTitle: 'Operator', department: null, phone: '+91 20 1', mobile: '+91 98 2', address: null, disclaimer: 'Confidential', brandColor: '#111111' });
    const own = composeSignatureData(base, saveSignatureInput.parse({ template: 'classic', options: { jobTitle: 'Lead', mobile: '+1 555', brandColor: '#0E7C66', social: { x: 'https://x.com/a' }, show: { department: true, disclaimer: false, email: false } } }).options);
    expect(own).toMatchObject({ jobTitle: 'Lead', department: 'Assembly', mobile: '+1 555', email: null, disclaimer: null, brandColor: '#0E7C66', social: { linkedin: 'https://linkedin.com/company/n', x: 'https://x.com/a' } });
    expect(composeSignatureData(base, saveSignatureInput.parse({ template: 'classic', options: { show: { social: false } } }).options).social).toEqual({});
  });

  it('checks choices and company settings', () => {
    expect(saveSignatureInput.parse({ template: 'banner', options: {} })).toMatchObject({ template: 'banner', syncMode: null, options: { font: 'Arial', show: { photo: true } } });
    expect(saveSignatureInput.safeParse({ template: 'nope', options: {} }).success).toBe(false);
    expect(saveSignatureInput.safeParse({ template: 'classic', options: { brandColor: 'red' } }).success).toBe(false);
    expect(saveSignatureInput.safeParse({ template: 'classic', options: { ctaUrl: 'javascript:x' } }).success).toBe(false);
    expect(saveSignatureInput.parse({ template: 'classic', options: { phone: '' } }).options.phone).toBeUndefined();
    expect(signatureSettingsInput.parse({})).toMatchObject({ syncMode: 'auto', defaultTemplate: 'classic', allowEmployeeSyncChoice: true });
  });
});
