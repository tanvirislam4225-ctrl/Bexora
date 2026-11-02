import React from 'react';
import {
  ArrowLeft,
  BookOpen,
  FileText,
  LayoutGrid,
  Lock,
  Scale,
  ShieldCheck,
  UserCheck,
} from 'lucide-react';
import { InfoTopicId, PublicSettings } from '../types';
import { getProtectionDurationHours } from '../lib/marketplaceLogic';

export interface InfoCenterViewProps {
  activeTopic: InfoTopicId;
  settings: PublicSettings;
  onSelectTopic: (topic: InfoTopicId) => void;
  onBrowseMarketplace: () => void;
  onOpenSellAsset: () => void;
  onOpenDealsPage: () => void;
}

interface TopicDefinition {
  id: InfoTopicId;
  group: 'trust' | 'legal';
  label: string;
  headline: string;
  summary: string;
  sections: Array<{
    heading: string;
    points: string[];
  }>;
}

function buildTopicCatalog(settings: PublicSettings): TopicDefinition[] {
  const siteName = (settings.siteName || 'BEXORA').trim() || 'BEXORA';
  const buyerFee = Number(settings.buyerFeePct ?? 5);
  const sellerFee = Number(settings.sellerFeePct ?? 5);
  const ytHours = getProtectionDurationHours('youtube');
  const fbHours = getProtectionDurationHours('facebook');
  const stdHours = getProtectionDurationHours('website');

  return [
    {
      id: 'how-buying-works',
      group: 'trust',
      label: 'How Buying Works',
      headline: `How Buying Digital Assets Works on ${siteName}`,
      summary:
        'Every purchase is protected by wallet-backed escrow, structured seller credential transfer proof, and a mandatory buyer verification window before seller payout.',
      sections: [
        {
          heading: '01. Browse Verified Listings or Place an Offer',
          points: [
            'Inspect live listings across YouTube, Facebook, Instagram, TikTok, Telegram, Websites, Domains, and Gaming accounts.',
            'Review moderator-verified monetization status, audience metrics, account age, and seller track record before committing.',
            'Buy immediately at the listed price or submit a binding bid offer for the seller to accept.',
          ],
        },
        {
          heading: '02. Fund Escrow via Your Wallet',
          points: [
            `Checkout reserves the asset price plus the ${buyerFee}% buyer escrow fee inside ${siteName} Escrow—funds are never sent directly to the seller upfront.`,
            'Once escrow is funded, a dedicated 3-party Deal Room opens for Buyer, Seller, and Admin.',
          ],
        },
        {
          heading: '03. Verify Ownership Within the Protection Window',
          points: [
            'The seller transfers primary ownership/admin access and uploads 2–3 verification screenshots in the Deal Room.',
            `Confirm receipt and audit security settings during your immutable protection timer (${ytHours}h / 7 days for YouTube channels, ${fbHours}h for Facebook & standard assets).`,
            'If any discrepancy arises before the deadline expires, file a Report inside the Deal Room to freeze automatic settlement for Admin review.',
          ],
        },
      ],
    },
    {
      id: 'how-selling-works',
      group: 'trust',
      label: 'How Selling Works',
      headline: `How Selling Digital Assets Works on ${siteName}`,
      summary:
        'List verifiable digital properties to serious buyers with guaranteed upfront buyer escrow funding before you hand over credentials.',
      sections: [
        {
          heading: '01. Verify Identity & Submit Proof Screenshots',
          points: [
            'Complete email verification and NID identity verification in your Profile to unlock trusted seller status.',
            'Create a listing with accurate metrics, monetization disclosures, and private analytics proof for Admin moderation.',
          ],
        },
        {
          heading: '02. Transfer Only After Escrow Is Funded',
          points: [
            'Never hand over login credentials or primary owner roles in pre-sale chat. Wait until the Deal Room status confirms Buyer Payment Locked in Escrow.',
            'Follow the category-specific handover checklist and submit 2–3 clear transfer proof screenshots inside the Deal Room.',
          ],
        },
        {
          heading: '03. Receive Net Escrow Settlement & Withdraw',
          points: [
            `Once the buyer protection window completes with zero open disputes, net proceeds (asset price minus the ${sellerFee}% seller commission) are credited to your Wallet.`,
            'Request withdrawal to your verified payout account (bKash, Nagad, Rocket, or Bank) from your Wallet.',
          ],
        },
      ],
    },
    {
      id: 'escrow-protection',
      group: 'trust',
      label: 'Escrow Protection',
      headline: 'Three-Party Escrow & Immutable Protection Timers',
      summary: `${siteName} holds 100% of buyer funds in neutral escrow until transfer proof is verified and the post-transfer security window completes cleanly.`,
      sections: [
        {
          heading: 'Category-Specific Security Windows',
          points: [
            `YouTube Channels: ${ytHours} hours (7 full days) to match Google Brand Account primary-owner promotion rules.`,
            `Facebook Pages & Profiles: ${fbHours} hours to audit Page Roles, Business Manager links, and payout settings.`,
            `Instagram, TikTok, Telegram, Websites, Domains & Gaming: ${stdHours} hours post-confirmation inspection window.`,
          ],
        },
        {
          heading: 'Immutable Timer & Dispute Freeze',
          points: [
            'Once buyer receipt confirmation sets `originalDeadlineMs`, the protection deadline is immutable and cannot be shortened.',
            'Opening an evidence-backed dispute report immediately increments `unresolvedReportCount` and blocks payout release until an Administrator adjudicates the case.',
          ],
        },
      ],
    },
    {
      id: 'buyer-verification',
      group: 'trust',
      label: 'Buyer Verification Guide',
      headline: 'Buyer Post-Transfer Security & Verification Checklist',
      summary:
        'Follow these mandatory security steps immediately after the seller initiates handover inside your Deal Room.',
      sections: [
        {
          heading: 'Account & Credential Hardening',
          points: [
            'Verify that the exact channel, page, domain, or game UID matches the approved listing URL and metrics.',
            'Update recovery email, recovery phone number, 2-Step Verification (authenticator app), and revoke any unrecognized connected third-party sessions or backup codes.',
            'For YouTube Brand Accounts, accept the Primary Owner invitation immediately and keep proof screenshots until the 7-day promotion completes.',
          ],
        },
        {
          heading: 'When to File a Deal Room Report',
          points: [
            'If credentials fail, hidden strikes/restrictions exist, or original owner recovery attempts occur, click Report Issue inside the Deal Room before your protection timer ends.',
          ],
        },
      ],
    },
    {
      id: 'seller-guidelines',
      group: 'trust',
      label: 'Seller Guidelines',
      headline: 'Seller Standards & Safe Handover Rules',
      summary:
        'Accurate disclosures and documented transfers protect sellers against unfounded claims and speed up moderation approval.',
      sections: [
        {
          heading: 'Truthful Listing Disclosures',
          points: [
            'Declare authentic subscriber/follower counts, traffic sources, monetization eligibility, and any active platform warnings.',
            'Do not embed personal phone numbers, WhatsApp links, Telegram handles, or external payment requests inside public titles, descriptions, or chat.',
          ],
        },
        {
          heading: 'Documented Handover Proof',
          points: [
            'Always upload 2–3 unedited screenshots showing role invitation, registrar push, or credential handover inside the Deal Room transfer form.',
          ],
        },
      ],
    },
    {
      id: 'listing-moderation',
      group: 'trust',
      label: 'Listing Moderation',
      headline: 'How Listings Are Reviewed & Verified',
      summary:
        'Every public listing passes structured validation and human Administrator moderation before appearing in the marketplace.',
      sections: [
        {
          heading: 'Verification Checks Performed',
          points: [
            'URL format and platform ownership consistency checks.',
            'Private inspection of seller-submitted revenue, monetization, and audience analytics evidence (stored in restricted `listingSecrets`, never exposed publicly).',
            'Clear distinction between Seller-Claimed monetization and Moderator-Verified monetization options.',
          ],
        },
      ],
    },
    {
      id: 'dispute-process',
      group: 'trust',
      label: 'Dispute & Support Process',
      headline: 'Three-Party Dispute Resolution Workflow',
      summary:
        'When a buyer or seller raises a concern during an active deal, Administrators review Deal Room logs, transfer screenshots, and timestamped evidence.',
      sections: [
        {
          heading: 'Step-by-Step Resolution',
          points: [
            '01. Either party opens a Report inside the Deal Room with a written explanation and optional evidence screenshots.',
            '02. Escrow settlement is automatically paused while Admin inspects seller transfer submissions and buyer verification evidence.',
            '03. Admin issues a documented decision—either releasing net seller payout (`led_release_...`) or executing an atomic buyer refund (`led_refund_...`).',
          ],
        },
      ],
    },
    {
      id: 'account-security',
      group: 'trust',
      label: 'Account Security',
      headline: 'Account, Wallet & Session Protection',
      summary: `${siteName} enforces verified authentication, strict Firestore access rules, and PII redaction across public surfaces.`,
      sections: [
        {
          heading: 'Built-In Security Safeguards',
          points: [
            'Wallet balances, NID verification documents, deposit receipts, and recent searches are strictly isolated per authenticated owner.',
            'Public activity tickers and profiles never expose email addresses, phone numbers, bKash/Nagad/Rocket numbers, or internal transaction IDs.',
            'You can mask your display name in public homepage activity tickers anytime under Profile → Edit Profile.',
          ],
        },
      ],
    },
    {
      id: 'terms-of-service',
      group: 'legal',
      label: 'Terms of Service',
      headline: `${siteName} Terms of Service`,
      summary:
        'These Terms govern access to the marketplace, wallet deposits, bidding, escrow Deal Rooms, and seller payouts.',
      sections: [
        {
          heading: '1. Marketplace Role & Escrow Mandate',
          points: [
            `${siteName} provides neutral marketplace discovery, moderation, and escrow settlement infrastructure between buyers and sellers of digital assets.`,
            'Off-platform payment solicitation or credential exchange outside an active funded Deal Room strictly violates these Terms and forfeits escrow protection.',
          ],
        },
        {
          heading: '2. Fees & Wallet Balances',
          points: [
            `Standard escrow fees are ${buyerFee}% buyer protection fee at checkout and ${sellerFee}% seller commission deducted upon settled payout, as displayed prior to confirmation.`,
            'All ledger entries are recorded immutably; duplicate releases or double refunds are prevented via deterministic ledger keys.',
          ],
        },
      ],
    },
    {
      id: 'privacy-policy',
      group: 'legal',
      label: 'Privacy Policy',
      headline: `${siteName} Privacy & Data Protection Policy`,
      summary:
        'How we collect, isolate, and protect personal, identity-verification, and transaction data.',
      sections: [
        {
          heading: '1. Private vs. Public Data Separation',
          points: [
            'Public profiles (`publicProfiles`) contain only public display name, username, optional bio/location, verified status flags, and aggregate trade/rating counts.',
            'Sensitive account fields (`privateUsers`), NID front/back images (`identityVerifications`), listing proof screenshots (`listingSecrets`), deposits, and withdrawals are strictly protected from public access.',
          ],
        },
        {
          heading: '2. Public Activity & Search Privacy',
          points: [
            'Homepage activity tickers display only sanitized public display names (or "Verified Seller" / "BEXORA User" when masked), asset titles, recorded amounts, and completion times.',
            'Recent search history is private to your account (or local browser when signed out) and can be deleted individually or cleared completely at any time.',
          ],
        },
      ],
    },
    {
      id: 'cookie-policy',
      group: 'legal',
      label: 'Cookie & Storage Policy',
      headline: 'Browser Storage & Session Persistence Policy',
      summary:
        'How local browser storage and indexed session tokens keep your account signed in and remember your interface preferences.',
      sections: [
        {
          heading: 'Essential Functional Storage',
          points: [
            'Firebase Authentication persistence (IndexedDB / localStorage) maintains your authenticated session across tab reloads.',
            'Preference keys store your selected Light/Dark theme, display currency (BDT / USD), language, notification sound preferences, and optional guest recent searches.',
            'We do not sell personal browsing history to third-party advertising networks.',
          ],
        },
      ],
    },
    {
      id: 'refund-policy',
      group: 'legal',
      label: 'Refund & Cancellation Policy',
      headline: 'Escrow Refund & Cancellation Policy',
      summary:
        'Clear, deterministic rules governing cancelled deals, seller non-delivery, and verified dispute refunds.',
      sections: [
        {
          heading: '1. Unpaid Reservations & Pre-Funding Cancellation',
          points: [
            'Before escrow payment is funded, no wallet funds are deducted from the buyer.',
          ],
        },
        {
          heading: '2. Approved Escrow Dispute Refunds',
          points: [
            'When an Administrator approves a buyer refund on a funded deal (due to seller non-delivery, failed verification, or misrepresented asset metrics), 100% of the base asset price plus 2% of the buyer escrow fee is credited back to the buyer wallet.',
            'A 3% platform handling/dispute processing portion is retained as documented in the Deal Room checkout breakdown, while full audit records are preserved.',
          ],
        },
      ],
    },
    {
      id: 'dispute-policy',
      group: 'legal',
      label: 'Dispute Resolution Policy',
      headline: 'Formal Escrow Dispute Policy',
      summary:
        'Evidence standards and timelines required during contested digital asset transfers.',
      sections: [
        {
          heading: 'Evidence & Good-Faith Cooperation',
          points: [
            'Both buyer and seller must respond to Admin evidence requests inside the Deal Room within the stated review window.',
            'Fabricated screenshots, unauthorized post-sale account clawbacks, or off-platform coercion result in immediate account suspension and wallet freeze.',
          ],
        },
      ],
    },
    {
      id: 'acceptable-use',
      group: 'legal',
      label: 'Acceptable Use Policy',
      headline: 'Marketplace Acceptable Use Policy',
      summary:
        'Prohibited assets, conduct, and security abuses strictly barred on the platform.',
      sections: [
        {
          heading: 'Prohibited Listings & Conduct',
          points: [
            'Stolen, phished, or unauthorized accounts; assets carrying undisclosed copyright/community bans; or illegal content.',
            'Sharing phone numbers, emails, external chat links, or direct payment details to bypass marketplace escrow.',
            'Automated scraping, credential stuffing, or submitting fraudulent deposit transaction IDs.',
          ],
        },
      ],
    },
    {
      id: 'user-responsibilities',
      group: 'legal',
      label: 'User Responsibilities',
      headline: 'Buyer & Seller Responsibilities',
      summary:
        'Shared operational responsibilities that keep digital asset ownership transfers safe and irreversible.',
      sections: [
        {
          heading: 'Core Member Duties',
          points: [
            'Buyers must audit transferred assets and rotate all recovery credentials promptly within the category protection window.',
            'Sellers must maintain full lawful authority to transfer the listed asset and never attempt post-settlement recovery.',
            'All members must safeguard their account credentials and verify payout details accurately before requesting withdrawals.',
          ],
        },
      ],
    },
  ];
}

export const InfoCenterView: React.FC<InfoCenterViewProps> = ({
  activeTopic,
  settings,
  onSelectTopic,
  onBrowseMarketplace,
  onOpenSellAsset,
  onOpenDealsPage,
}) => {
  const catalog = buildTopicCatalog(settings);
  const current = catalog.find((t) => t.id === activeTopic) || catalog[0];
  const trustTopics = catalog.filter((t) => t.group === 'trust');
  const legalTopics = catalog.filter((t) => t.group === 'legal');

  const cleanWhatsapp = (settings.supportWhatsapp || '').trim();
  const cleanTelegram = (settings.supportTelegram || '').trim();
  const cleanEmail = (settings.supportEmail || '').trim();
  const hasAnySupport = Boolean(cleanWhatsapp || cleanTelegram || cleanEmail);

  return (
    <section
      className="bx-wrap-wide py-8 space-y-6"
      aria-label="Trust, Safety and Legal Center"
      data-testid="info-center-view"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBrowseMarketplace}
          className="bx-btn bx-btn-sm whitespace-nowrap"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Marketplace</span>
        </button>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onOpenDealsPage}
            className="bx-btn bx-btn-sm whitespace-nowrap"
          >
            <ShieldCheck className="w-4 h-4" />
            <span>Open Escrow Deals</span>
          </button>
          <button
            type="button"
            onClick={onOpenSellAsset}
            className="bx-btn bx-btn-primary bx-btn-sm whitespace-nowrap"
          >
            <span>Sell an Asset</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Topic Sidebar */}
        <aside className="lg:col-span-4 xl:col-span-3 bx-card p-4 space-y-5">
          <div className="space-y-1.5">
            <div
              className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wider px-2"
              style={{ color: 'var(--purple)' }}
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Trust &amp; Escrow Guides</span>
            </div>
            <nav aria-label="Trust and safety guides" className="flex flex-col gap-1">
              {trustTopics.map((topic) => {
                const active = topic.id === current.id;
                return (
                  <button
                    key={topic.id}
                    type="button"
                    onClick={() => onSelectTopic(topic.id)}
                    className="text-left px-3 py-2 rounded-lg text-xs font-bold transition-colors"
                    style={{
                      background: active ? 'var(--purple-soft)' : 'transparent',
                      color: active ? 'var(--purple)' : 'var(--text-2)',
                    }}
                  >
                    {topic.label}
                  </button>
                );
              })}
            </nav>
          </div>

          <div
            className="pt-4 border-t space-y-1.5"
            style={{ borderColor: 'var(--border-soft)' }}
          >
            <div
              className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wider px-2"
              style={{ color: 'var(--text-2)' }}
            >
              <Scale className="w-3.5 h-3.5" />
              <span>Policies &amp; Legal</span>
            </div>
            <nav aria-label="Policies and legal documents" className="flex flex-col gap-1">
              {legalTopics.map((topic) => {
                const active = topic.id === current.id;
                return (
                  <button
                    key={topic.id}
                    type="button"
                    onClick={() => onSelectTopic(topic.id)}
                    className="text-left px-3 py-2 rounded-lg text-xs font-bold transition-colors"
                    style={{
                      background: active ? 'var(--purple-soft)' : 'transparent',
                      color: active ? 'var(--purple)' : 'var(--text-2)',
                    }}
                  >
                    {topic.label}
                  </button>
                );
              })}
            </nav>
          </div>
        </aside>

        {/* Active Topic Document */}
        <article className="lg:col-span-8 xl:col-span-9 bx-card p-6 sm:p-8 space-y-6">
          <header
            className="space-y-2 pb-5 border-b"
            style={{ borderColor: 'var(--border-soft)' }}
          >
            <div
              className="inline-flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wider"
              style={{ color: 'var(--purple)' }}
            >
              {current.group === 'trust' ? (
                <>
                  <BookOpen className="w-3.5 h-3.5" />
                  <span>Marketplace Trust &amp; Safety</span>
                </>
              ) : (
                <>
                  <FileText className="w-3.5 h-3.5" />
                  <span>Platform Governance &amp; Policy</span>
                </>
              )}
            </div>
            <h1 className="text-2xl sm:text-3xl font-black tracking-tight">
              {current.headline}
            </h1>
            <p className="text-sm sm:text-base leading-relaxed max-w-3xl" style={{ color: 'var(--text-2)' }}>
              {current.summary}
            </p>
          </header>

          <div className="space-y-6">
            {current.sections.map((sec) => (
              <section key={sec.heading} className="space-y-2.5">
                <h2 className="text-base sm:text-lg font-extrabold" style={{ color: 'var(--text)' }}>
                  {sec.heading}
                </h2>
                <ul className="space-y-2 text-sm leading-relaxed" style={{ color: 'var(--text-2)' }}>
                  {sec.points.map((pt, idx) => (
                    <li key={idx} className="flex items-start gap-2.5">
                      <span
                        aria-hidden="true"
                        className="font-extrabold select-none shrink-0"
                        style={{ color: 'var(--orange)' }}
                      >
                        •
                      </span>
                      <span>{pt}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>

          <footer
            className="pt-5 border-t flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-xs"
            style={{ borderColor: 'var(--border-soft)', color: 'var(--text-2)' }}
          >
            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-1 font-bold">
                <Lock className="w-3.5 h-3.5" style={{ color: 'var(--green)' }} />
                <span>3-Party Wallet Escrow Enforced</span>
              </span>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1 font-bold">
                <UserCheck className="w-3.5 h-3.5" style={{ color: 'var(--purple)' }} />
                <span>NID &amp; Moderator Proof Verification</span>
              </span>
            </div>

            {hasAnySupport ? (
              <div className="flex flex-wrap items-center gap-3 font-bold">
                {cleanEmail && (
                  <a href={`mailto:${cleanEmail}`} className="hover:underline" style={{ color: 'var(--text)' }}>
                    {cleanEmail}
                  </a>
                )}
                {cleanWhatsapp && (
                  <a
                    href={
                      cleanWhatsapp.startsWith('http')
                        ? cleanWhatsapp
                        : `https://wa.me/${cleanWhatsapp.replace(/[^\d]/g, '')}`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                    style={{ color: 'var(--green)' }}
                  >
                    WhatsApp Support
                  </a>
                )}
                {cleanTelegram && (
                  <a
                    href={
                      cleanTelegram.startsWith('http')
                        ? cleanTelegram
                        : `https://t.me/${cleanTelegram.replace(/^@/, '')}`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                    style={{ color: 'var(--purple)' }}
                  >
                    Telegram Support
                  </a>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={onBrowseMarketplace}
                className="inline-flex items-center gap-1.5 font-extrabold hover:underline"
                style={{ color: 'var(--purple)' }}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                <span>Explore Live Marketplace</span>
              </button>
            )}
          </footer>
        </article>
      </div>
    </section>
  );
};
