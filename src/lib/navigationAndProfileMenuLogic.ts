export type ProfileMenuActionId =
  | 'dashboard'
  | 'deposit'
  | 'withdraw'
  | 'public_profile'
  | 'safety_appeals'
  | 'admin'
  | 'logout';

export interface ProfileMenuActionDescriptor {
  id: ProfileMenuActionId;
  label: string;
  section: 'primary' | 'footer';
  isDestructive: boolean;
}

export interface BuildProfileMenuInput {
  userUid: string | null;
  isAdmin: boolean;
  signingOut?: boolean;
}

/**
 * Builds the structured desktop/tablet/mobile Profile Dropdown Menu items.
 * Ensures Logout is always placed in its own visually separated footer section
 * whenever a user is authenticated.
 */
export function buildProfileMenuActions(
  input: BuildProfileMenuInput
): ProfileMenuActionDescriptor[] {
  if (!input.userUid) {
    return [];
  }

  const items: ProfileMenuActionDescriptor[] = [
    {
      id: 'dashboard',
      label: 'Main Dashboard',
      section: 'primary',
      isDestructive: false,
    },
    {
      id: 'deposit',
      label: 'Deposit',
      section: 'primary',
      isDestructive: false,
    },
    {
      id: 'withdraw',
      label: 'Withdraw',
      section: 'primary',
      isDestructive: false,
    },
    {
      id: 'public_profile',
      label: 'View Public Profile',
      section: 'primary',
      isDestructive: false,
    },
    {
      id: 'safety_appeals',
      label: 'Safety & Appeals',
      section: 'primary',
      isDestructive: false,
    },
  ];

  if (input.isAdmin) {
    items.push({
      id: 'admin',
      label: 'Admin Console',
      section: 'primary',
      isDestructive: false,
    });
  }

  items.push({
    id: 'logout',
    label: input.signingOut ? 'Signing out…' : 'Logout',
    section: 'footer',
    isDestructive: true,
  });

  return items;
}

/**
 * Desktop inline navigation activates at Tailwind `xl` (>= 1280px).
 * Below 1280px (mobile, small/standard/large tablets in portrait or landscape),
 * the hamburger drawer is used.
 */
export const DESKTOP_INLINE_NAV_MIN_WIDTH = 1280;

export function shouldLockBodyScrollForDrawer(drawerOpen: boolean): boolean {
  return Boolean(drawerOpen);
}

export function shouldAutoCloseDrawerOnViewportWidth(
  drawerOpen: boolean,
  viewportWidth: number
): boolean {
  return Boolean(drawerOpen) && Number.isFinite(viewportWidth) && viewportWidth >= DESKTOP_INLINE_NAV_MIN_WIDTH;
}
