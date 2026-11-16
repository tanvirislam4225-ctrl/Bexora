import React from 'react';
import { Calculator } from 'lucide-react';
import type { LanguageCode } from '../../types';
import { formatMoneyFromMinor, PLATFORM_CATALOG, PLATFORM_LIST } from '../../lib/marketplaceLogic';
import { SUPPORTED_LANGUAGES } from '../../lib/i18n';
import { DismissibleNotice } from '../DismissibleNotice';

interface CommissionSectionProps {
  buyerFeeEnabled: boolean;
  setBuyerFeeEnabled: (v: boolean) => void;
  buyerFeePct: string;
  setBuyerFeePct: (v: string) => void;
  sellerFeeEnabled: boolean;
  setSellerFeeEnabled: (v: boolean) => void;
  sellerFeePct: string;
  setSellerFeePct: (v: string) => void;
  usdRate: string;
  setUsdRate: (v: string) => void;
  calcSampleBdt: string;
  setCalcSampleBdt: (v: string) => void;
  liveSample: {
    baseAmountMinor: number;
    buyerFeePct: number;
    buyerFeeMinor: number;
    buyerTotalMinor: number;
    sellerFeePct: number;
    sellerFeeMinor: number;
    sellerPayoutMinor: number;
  };
  liveSampleRefund: {
    buyerRefundMinor: number;
    platformRetainedCommissionMinor: number;
  };
  onSubmit: (e: React.FormEvent) => void;
}

export const AdminCommissionsSection: React.FC<CommissionSectionProps> = ({
  buyerFeeEnabled,
  setBuyerFeeEnabled,
  buyerFeePct,
  setBuyerFeePct,
  sellerFeeEnabled,
  setSellerFeeEnabled,
  sellerFeePct,
  setSellerFeePct,
  usdRate,
  setUsdRate,
  calcSampleBdt,
  setCalcSampleBdt,
  liveSample,
  liveSampleRefund,
  onSubmit,
}) => (
  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
    <form onSubmit={onSubmit} className="bx-card p-6 space-y-5">
      <h1 className="text-xl font-black">Configurable Commission Engine</h1>
      <p className="text-xs opacity-75">
        Standard BEXORA Buyer Fee is 5% on the exact accepted bid or Buy Now price. Fees are locked immutably into each deal snapshot at creation.
      </p>

      <div className="p-4 border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-3">
        <label className="flex items-center justify-between cursor-pointer min-h-[36px]">
          <span className="text-sm font-black">Enable Buyer Fee (Default 5%)</span>
          <input
            type="checkbox"
            checked={buyerFeeEnabled}
            onChange={(e) => setBuyerFeeEnabled(e.target.checked)}
            className="w-5 h-5"
          />
        </label>
        <div>
          <label htmlFor="bx-admin-buyer-pct" className="block text-xs font-bold mb-1">
            Buyer Commission Percentage (0% – 50%)
          </label>
          <input
            id="bx-admin-buyer-pct"
            type="number"
            step="0.1"
            min="0"
            max="50"
            value={buyerFeePct}
            onChange={(e) => setBuyerFeePct(e.target.value)}
            className="bx-input w-full px-3 py-2 text-sm"
          />
        </div>
      </div>

      <div className="p-4 border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-3">
        <label className="flex items-center justify-between cursor-pointer min-h-[36px]">
          <span className="text-sm font-black">Enable Seller Fee</span>
          <input
            type="checkbox"
            checked={sellerFeeEnabled}
            onChange={(e) => setSellerFeeEnabled(e.target.checked)}
            className="w-5 h-5"
          />
        </label>
        <div>
          <label htmlFor="bx-admin-seller-pct" className="block text-xs font-bold mb-1">
            Seller Commission Percentage (0% – 50%)
          </label>
          <input
            id="bx-admin-seller-pct"
            type="number"
            step="0.1"
            min="0"
            max="50"
            value={sellerFeePct}
            onChange={(e) => setSellerFeePct(e.target.value)}
            className="bx-input w-full px-3 py-2 text-sm"
          />
        </div>
      </div>

      <div>
        <label htmlFor="bx-admin-usd-rate" className="block text-xs font-bold mb-1">
          Display Conversion Rate (1 USD in BDT)
        </label>
        <input
          id="bx-admin-usd-rate"
          type="number"
          step="0.5"
          min="1"
          max="500"
          value={usdRate}
          onChange={(e) => setUsdRate(e.target.value)}
          className="bx-input w-full px-3 py-2 text-sm"
        />
      </div>

      <button type="submit" className="bx-btn bx-btn-primary w-full py-2.5 text-sm font-extrabold">
        Save Commission Settings
      </button>
    </form>

    <div className="bx-card p-6 space-y-4 tabular-nums">
      <div className="flex items-center gap-2">
        <Calculator className="w-5 h-5 text-[#FF6500]" />
        <h2 className="text-lg font-black">Live Payment & Dispute Refund Preview</h2>
      </div>
      <div>
        <label htmlFor="bx-sample-deal" className="block text-xs font-bold mb-1">
          Accepted Bid / Deal Base Price (BDT)
        </label>
        <input
          id="bx-sample-deal"
          type="number"
          min="10"
          value={calcSampleBdt}
          onChange={(e) => setCalcSampleBdt(e.target.value)}
          className="bx-input w-full px-3 py-2 text-sm"
        />
      </div>

      <div className="space-y-2.5 text-sm border-t-2 border-[var(--bx-border)] pt-4">
        <div className="flex justify-between gap-2">
          <span>Accepted Bid / Deal Price (P):</span>
          <span className="font-bold">{formatMoneyFromMinor(liveSample.baseAmountMinor, 'BDT', 'BDT')}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span>Buyer Fee ({liveSample.buyerFeePct}%):</span>
          <span className="font-bold">+{formatMoneyFromMinor(liveSample.buyerFeeMinor, 'BDT', 'BDT')}</span>
        </div>
        <div className="flex justify-between gap-2 font-black text-[#FF6500] border-b border-[var(--bx-border)] pb-2">
          <span>Buyer Total Charge (P + BuyerFee):</span>
          <span>{formatMoneyFromMinor(liveSample.buyerTotalMinor, 'BDT', 'BDT')}</span>
        </div>
        <div className="flex justify-between gap-2 pt-1">
          <span>Seller Fee ({liveSample.sellerFeePct}%):</span>
          <span className="font-bold">-{formatMoneyFromMinor(liveSample.sellerFeeMinor, 'BDT', 'BDT')}</span>
        </div>
        <div className="flex justify-between gap-2 font-black text-emerald-600">
          <span>If Completed → Seller Net Payout:</span>
          <span>{formatMoneyFromMinor(liveSample.sellerPayoutMinor, 'BDT', 'BDT')}</span>
        </div>
        <div className="flex justify-between gap-2 pt-2 border-t border-[var(--bx-border)] text-red-600 font-black">
          <span>If Admin Rejects Deal → Buyer Refund:</span>
          <span>{formatMoneyFromMinor(liveSampleRefund.buyerRefundMinor, 'BDT', 'BDT')}</span>
        </div>
        <div className="flex justify-between gap-2 text-xs opacity-85 font-bold">
          <span>If Admin Rejects Deal → Retained BEXORA Commission (3%):</span>
          <span>{formatMoneyFromMinor(liveSampleRefund.platformRetainedCommissionMinor, 'BDT', 'BDT')}</span>
        </div>
      </div>
    </div>
  </div>
);

interface CategoriesSectionProps {
  customProtEnabled: boolean;
  setCustomProtEnabled: (v: boolean) => void;
  protYt: string;
  setProtYt: (v: string) => void;
  protFb: string;
  setProtFb: (v: string) => void;
  protDef: string;
  setProtDef: (v: string) => void;
  gamingText: string;
  setGamingText: (v: string) => void;
  disabledMonIds: string[];
  setDisabledMonIds: React.Dispatch<React.SetStateAction<string[]>>;
  onSubmit: (e: React.FormEvent) => void;
}

export const AdminCategoriesSection: React.FC<CategoriesSectionProps> = ({
  customProtEnabled,
  setCustomProtEnabled,
  protYt,
  setProtYt,
  protFb,
  setProtFb,
  protDef,
  setProtDef,
  gamingText,
  setGamingText,
  disabledMonIds,
  setDisabledMonIds,
  onSubmit,
}) => (
  <form onSubmit={onSubmit} className="bx-card p-6 space-y-6">
    <h1 className="text-xl font-black">Categories, Gaming List &amp; Asset Security Windows</h1>

    <div className="p-4 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-2">
      <label className="flex items-center justify-between gap-3 cursor-pointer">
        <span className="text-xs font-black">
          Allow Custom Override of Mandatory Security Windows (Default Off: Enforces 168h YouTube &amp; 40h Standard)
        </span>
        <input
          type="checkbox"
          checked={customProtEnabled}
          onChange={(e) => setCustomProtEnabled(e.target.checked)}
          className="w-5 h-5 shrink-0"
        />
      </label>
      <p className="text-[11px] opacity-75">
        When unchecked, YouTube channels strictly lock a 7-day (168h) Google Brand/Primary-Owner hold and Facebook &amp; all other standard assets lock a 40-hour security hold upon Buyer transfer approval.
      </p>
    </div>

    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div>
        <label htmlFor="bx-prot-yt" className="block text-xs font-extrabold mb-1">
          YouTube Security Window (Hours)
        </label>
        <input
          id="bx-prot-yt"
          type="number"
          min="1"
          max="720"
          value={protYt}
          onChange={(e) => setProtYt(e.target.value)}
          className="bx-input w-full px-3 py-2 text-sm"
        />
        <p className="text-[11px] opacity-70 mt-1">Mandatory Policy: 168h (7 days)</p>
      </div>
      <div>
        <label htmlFor="bx-prot-fb" className="block text-xs font-extrabold mb-1">
          Facebook Security Window (Hours)
        </label>
        <input
          id="bx-prot-fb"
          type="number"
          min="1"
          max="720"
          value={protFb}
          onChange={(e) => setProtFb(e.target.value)}
          className="bx-input w-full px-3 py-2 text-sm"
        />
        <p className="text-[11px] opacity-70 mt-1">Mandatory Policy: 40h</p>
      </div>
      <div>
        <label htmlFor="bx-prot-def" className="block text-xs font-extrabold mb-1">
          Other Standard Assets (Hours)
        </label>
        <input
          id="bx-prot-def"
          type="number"
          min="1"
          max="720"
          value={protDef}
          onChange={(e) => setProtDef(e.target.value)}
          className="bx-input w-full px-3 py-2 text-sm"
        />
        <p className="text-[11px] opacity-70 mt-1">Mandatory Policy: 40h</p>
      </div>
    </div>

    <div>
      <label htmlFor="bx-gaming-list" className="block text-xs font-extrabold mb-1">
        Supported Gaming Titles (One game per line)
      </label>
      <textarea
        id="bx-gaming-list"
        rows={5}
        value={gamingText}
        onChange={(e) => setGamingText(e.target.value)}
        className="bx-input w-full px-3 py-2 text-sm font-mono"
      />
    </div>

    <div className="space-y-3">
      <div className="text-xs font-extrabold uppercase">Toggle Platform Monetization Programs</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {PLATFORM_LIST.filter((p) => PLATFORM_CATALOG[p].monetizationOptions.length > 0).map((p) => (
          <div key={p} className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-2">
            <div className="text-xs font-black uppercase">{PLATFORM_CATALOG[p].name}</div>
            <div className="flex flex-wrap gap-2">
              {PLATFORM_CATALOG[p].monetizationOptions.map((opt) => {
                const enabled = !disabledMonIds.includes(opt.id);
                return (
                  <label key={opt.id} className="inline-flex items-center gap-1.5 text-xs font-bold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={() =>
                        setDisabledMonIds((prev) =>
                          enabled ? [...prev, opt.id] : prev.filter((x) => x !== opt.id)
                        )
                      }
                    />
                    <span>{opt.name}</span>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>

    <button type="submit" className="bx-btn bx-btn-primary px-6 py-2.5 text-sm font-extrabold">
      Save Category &amp; Protection Configuration
    </button>
  </form>
);

interface SupportAndBrandingSectionProps {
  supWa: string;
  setSupWa: (v: string) => void;
  supTg: string;
  setSupTg: (v: string) => void;
  supEmail: string;
  setSupEmail: (v: string) => void;
  siteNameInput: string;
  setSiteNameInput: (v: string) => void;
  logoUrlInput: string;
  setLogoUrlInput: (v: string) => void;
  brandTaglineInput: string;
  setBrandTaglineInput: (v: string) => void;
  noticeBannerEnabledInput: boolean;
  setNoticeBannerEnabledInput: (v: boolean) => void;
  noticeBannerTextInput: string;
  setNoticeBannerTextInput: (v: string) => void;
  enabledLanguagesInput: LanguageCode[];
  setEnabledLanguagesInput: React.Dispatch<React.SetStateAction<LanguageCode[]>>;
  onSaveSupportContacts: (e: React.FormEvent) => void;
  onSaveBrandingAndNotice: (e: React.FormEvent) => void;
}

export const AdminSupportAndBrandingSection: React.FC<SupportAndBrandingSectionProps> = ({
  supWa,
  setSupWa,
  supTg,
  setSupTg,
  supEmail,
  setSupEmail,
  siteNameInput,
  setSiteNameInput,
  logoUrlInput,
  setLogoUrlInput,
  brandTaglineInput,
  setBrandTaglineInput,
  noticeBannerEnabledInput,
  setNoticeBannerEnabledInput,
  noticeBannerTextInput,
  setNoticeBannerTextInput,
  enabledLanguagesInput,
  setEnabledLanguagesInput,
  onSaveSupportContacts,
  onSaveBrandingAndNotice,
}) => (
  <div className="space-y-6 max-w-3xl">
    <form onSubmit={onSaveSupportContacts} className="bx-card p-6 space-y-5">
      <h1 className="text-xl font-black">Support Contact Settings</h1>
      <p className="text-xs opacity-75">
        Updates immediately sync with the Floating Support Button across all pages. Leave blank to hide an unconfigured channel.
      </p>

      <div>
        <label htmlFor="bx-sup-wa" className="block text-xs font-extrabold mb-1">
          WhatsApp Support Number (with country code)
        </label>
        <input
          id="bx-sup-wa"
          type="text"
          value={supWa}
          onChange={(e) => setSupWa(e.target.value)}
          placeholder="+8801700000000"
          className="bx-input w-full px-3.5 py-2.5 text-sm"
        />
      </div>

      <div>
        <label htmlFor="bx-sup-tg" className="block text-xs font-extrabold mb-1">
          Telegram Support URL or @Handle
        </label>
        <input
          id="bx-sup-tg"
          type="text"
          value={supTg}
          onChange={(e) => setSupTg(e.target.value)}
          placeholder="https://t.me/bexorasupport"
          className="bx-input w-full px-3.5 py-2.5 text-sm"
        />
      </div>

      <div>
        <label htmlFor="bx-sup-email" className="block text-xs font-extrabold mb-1">
          Support Desk Email Address
        </label>
        <input
          id="bx-sup-email"
          type="email"
          value={supEmail}
          onChange={(e) => setSupEmail(e.target.value)}
          placeholder="support@bexora.com"
          className="bx-input w-full px-3.5 py-2.5 text-sm"
        />
      </div>

      <button type="submit" className="bx-btn bx-btn-primary px-6 py-2.5 text-sm font-extrabold">
        Save Support Channels
      </button>
    </form>

    <form onSubmit={onSaveBrandingAndNotice} className="bx-card p-6 space-y-5">
      <div>
        <h2 className="text-lg font-black">
          Platform Branding, Top Notice Banner &amp; Active Languages
        </h2>
        <DismissibleNotice id="branding-intro" className="mt-1">
          <p className="text-xs opacity-75">
            Customize site display name, custom HTTPS brand logo URL (leave blank to use the default BEXORA geometric emblem), top announcement notice bar, and enabled customer languages.
          </p>
        </DismissibleNotice>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="bx-brand-name" className="block text-xs font-extrabold mb-1">
            Platform Display Name
          </label>
          <input
            id="bx-brand-name"
            type="text"
            value={siteNameInput}
            onChange={(e) => setSiteNameInput(e.target.value)}
            placeholder="BEXORA"
            maxLength={60}
            className="bx-input w-full px-3.5 py-2.5 text-sm"
          />
        </div>
        <div>
          <label htmlFor="bx-brand-logo" className="block text-xs font-extrabold mb-1">
            Custom Logo Image URL (Optional HTTPS)
          </label>
          <input
            id="bx-brand-logo"
            type="text"
            value={logoUrlInput}
            onChange={(e) => setLogoUrlInput(e.target.value)}
            placeholder="Leave blank for default BEXORA emblem"
            maxLength={300}
            className="bx-input w-full px-3.5 py-2.5 text-sm"
          />
        </div>
      </div>

      <div>
        <label htmlFor="bx-brand-tagline" className="block text-xs font-extrabold mb-1">
          Footer / Brand Tagline
        </label>
        <input
          id="bx-brand-tagline"
          type="text"
          value={brandTaglineInput}
          onChange={(e) => setBrandTaglineInput(e.target.value)}
          placeholder="Verified Digital Asset Marketplace & Protected Escrow"
          maxLength={140}
          className="bx-input w-full px-3.5 py-2.5 text-sm"
        />
      </div>

      <div className="p-4 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-3">
        <label className="flex items-center gap-2.5 text-xs font-extrabold cursor-pointer">
          <input
            type="checkbox"
            checked={noticeBannerEnabledInput}
            onChange={(e) => setNoticeBannerEnabledInput(e.target.checked)}
            className="w-4 h-4 accent-[#FF6500]"
          />
          <span>Show Top Sitewide Notice Banner Above Header</span>
        </label>
        <input
          type="text"
          value={noticeBannerTextInput}
          onChange={(e) => setNoticeBannerTextInput(e.target.value)}
          placeholder="e.g., Escrow payouts & manual bKash/Nagad deposits are processed 24/7."
          maxLength={280}
          className="bx-input w-full px-3 py-2 text-xs"
        />
      </div>

      <div className="space-y-2">
        <div className="text-xs font-extrabold">Enabled Header Languages</div>
        <div className="flex flex-wrap gap-2">
          {SUPPORTED_LANGUAGES.map((lMeta) => {
            const active = enabledLanguagesInput.includes(lMeta.code);
            return (
              <label
                key={lMeta.code}
                className="inline-flex items-center gap-2 px-3 py-2 border border-[var(--bx-border)] bg-[var(--bx-surface)] text-xs font-bold cursor-pointer min-h-[40px]"
              >
                <input
                  type="checkbox"
                  checked={active}
                  onChange={() =>
                    setEnabledLanguagesInput((prev) => {
                      if (active) {
                        const next = prev.filter((x) => x !== lMeta.code);
                        return next.length > 0 ? next : ['en'];
                      }
                      return [...prev, lMeta.code];
                    })
                  }
                />
                <span>
                  {lMeta.label} ({lMeta.code.toUpperCase()})
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <button type="submit" className="bx-btn bx-btn-primary px-6 py-2.5 text-sm font-extrabold">
        Save Branding, Notice &amp; Languages
      </button>
    </form>
  </div>
);
