import { LanguageCode } from '../types';

export interface LanguageMeta {
  code: LanguageCode;
  label: string;
  dir: 'ltr' | 'rtl';
}

export const SUPPORTED_LANGUAGES: LanguageMeta[] = [
  { code: 'en', label: 'English', dir: 'ltr' },
  { code: 'bn', label: 'বাংলা', dir: 'ltr' },
  { code: 'hi', label: 'हिन्दी', dir: 'ltr' },
  { code: 'ar', label: 'العربية', dir: 'rtl' },
  { code: 'ur', label: 'اردو', dir: 'rtl' },
];

const DICTIONARY: Record<LanguageCode, Record<string, string>> = {
  en: {
    nav_home: 'Home',
    nav_market: 'Marketplace',
    nav_sellers: 'Top Sellers',
    nav_chat: 'Chat',
    nav_deals: 'Deals',
    nav_profile: 'Profile',
    nav_admin: 'Admin',
    btn_login: 'Sign In',
    btn_sell: 'Sell Asset',
    btn_install: 'Install App',
    hero_eyebrow: 'Verified Digital Asset Marketplace',
    hero_title: 'Buy and sell digital assets you can verify.',
    hero_sub: 'Channels, pages, accounts, websites, domains, and gaming assets — backed by escrow protection, transparent monetization evidence, and real transaction ratings.',
    search_placeholder: 'Search channels, pages, websites, or games…',
    no_listings: 'No listings available yet.',
    no_ratings: 'No ratings yet',
  },
  bn: {
    nav_home: 'হোম',
    nav_market: 'মার্কেটপ্লেস',
    nav_sellers: 'সেরা বিক্রেতা',
    nav_chat: 'চ্যাট',
    nav_deals: 'ডিলসমূহ',
    nav_profile: 'প্রোফাইল',
    nav_admin: 'অ্যাডমিন',
    btn_login: 'লগইন',
    btn_sell: 'অ্যাসেট বিক্রি করুন',
    btn_install: 'অ্যাপ ইনস্টল করুন',
    hero_eyebrow: 'ডিজিটাল অ্যাসেট মার্কেটপ্লেস',
    hero_title: 'যাচাইযোগ্য ডিজিটাল অ্যাসেট নিরাপদে কেনা-বেচা করুন।',
    hero_sub: 'ইউটিউব চ্যানেল, ফেসবুক পেজ, ওয়েবসাইট, ডোমেইন ও গেমিং অ্যাকাউন্ট — এসক্রো সুরক্ষা ও স্বচ্ছ মনিটাইজেশন যাচাইসহ।',
    search_placeholder: 'চ্যানেল, পেজ, ওয়েবসাইট বা গেম খুঁজুন…',
    no_listings: 'এখনো কোনো লিস্টিং উপলব্ধ নেই।',
    no_ratings: 'এখনো কোনো রেটিং নেই',
  },
  hi: {
    nav_home: 'होम',
    nav_market: 'मार्केटप्लेस',
    nav_sellers: 'शीर्ष विक्रेता',
    nav_chat: 'चैट',
    nav_deals: 'डील्स',
    nav_profile: 'प्रोफ़ाइल',
    nav_admin: 'एडमिन',
    btn_login: 'साइन इन',
    btn_sell: 'एसेट बेचें',
    btn_install: 'ऐप इंस्टॉल करें',
    hero_eyebrow: 'डिजिटल एसेट मार्केटप्लेस',
    hero_title: 'सत्यापित डिजिटल एसेट्स सुरक्षित रूप से खरीदें और बेचें।',
    hero_sub: 'चैनल, पेज, अकाउंट, वेबसाइट, डोमेन और गेमिंग एसेट्स — एस्क्रो सुरक्षा और पारदर्शी मोनेटाइजेशन सत्यापन के साथ।',
    search_placeholder: 'चैनल, पेज, वेबसाइट या गेम खोजें…',
    no_listings: 'अभी तक कोई लिस्टिंग उपलब्ध नहीं है।',
    no_ratings: 'अभी तक कोई रेटिंग नहीं',
  },
  ar: {
    nav_home: 'الرئيسية',
    nav_market: 'السوق',
    nav_sellers: 'أفضل البائعين',
    nav_chat: 'المحادثات',
    nav_deals: 'الصفقات',
    nav_profile: 'الملف الشخصي',
    nav_admin: 'الإدارة',
    btn_login: 'تسجيل الدخول',
    btn_sell: 'بيع أصل رقمي',
    btn_install: 'تثبيت التطبيق',
    hero_eyebrow: 'سوق الأصول الرقمية الموثوق',
    hero_title: 'اشترِ وبِع الأصول الرقمية التي يمكنك التحقق منها.',
    hero_sub: 'قنوات وصفحات وحسابات ومواقع ونطاقات وحسابات ألعاب مع حماية الضمان والتحقق من تحقيق الدخل.',
    search_placeholder: 'ابحث عن قنوات أو صفحات أو مواقع أو ألعاب…',
    no_listings: 'لا توجد عروض متاحة حتى الآن.',
    no_ratings: 'لا توجد تقييمات بعد',
  },
  ur: {
    nav_home: 'ہوم',
    nav_market: 'مارکیٹ پلیس',
    nav_sellers: 'ٹاپ سیلرز',
    nav_chat: 'چیٹ',
    nav_deals: 'ڈیلز',
    nav_profile: 'پروفائل',
    nav_admin: 'ایڈمن',
    btn_login: 'سائن ان',
    btn_sell: 'اثاثہ بیچیں',
    btn_install: 'ایپ انسٹال کریں',
    hero_eyebrow: 'ڈیجیٹل اثاثہ مارکیٹ پلیس',
    hero_title: 'ایسے ڈیجیٹل اثاثے خریدیں اور بیچیں جن کی آپ تصدیق کر سکیں۔',
    hero_sub: 'چینلز، پیجز، اکاؤنٹس، ویب سائٹس، ڈومینز اور گیمنگ اکاؤنٹس — ایسکرو تحفظ اور شفاف مونیٹائزیشن تصدیق کے ساتھ۔',
    search_placeholder: 'چینلز، پیجز، ویب سائٹس یا گیمز تلاش کریں…',
    no_listings: 'ابھی تک کوئی لسٹنگ دستیاب نہیں ہے۔',
    no_ratings: 'ابھی تک کوئی ریٹنگ نہیں',
  },
};

export function t(lang: LanguageCode, key: string): string {
  return DICTIONARY[lang]?.[key] ?? DICTIONARY.en[key] ?? key;
}

export function isRtlLanguage(lang: LanguageCode): boolean {
  return lang === 'ar' || lang === 'ur';
}
