import {render} from 'solid-js/web';
import appNavigationController from '@components/appNavigationController';
import ProfileView, {ProfileAction} from './profileView';

const OPEN_BODY_CLASS = 'svipe-profile-open';

export type ProfileOpenOptions = {
  onClose?: () => void;
  /** Action-row buttons (Set Photo / Edit Info / Settings / Contacts). */
  onAction?: (action: ProfileAction) => void;
};

/**
 * Owns the Profile-tab surface (Android's own-profile ProfileActivity page).
 * Non-persistent on purpose: Android drops and recreates the profile fragment
 * whenever you page away, so it is always fresh.
 */
class ProfileController {
  private dispose?: () => void;
  private onCloseCb?: () => void;

  public get isOpen() {
    return !!this.dispose;
  }

  public open(opts?: ProfileOpenOptions) {
    if(this.dispose) return;
    this.onCloseCb = opts?.onClose;

    const mount = document.getElementById('svipe-profile');
    if(!mount) return;

    document.body.classList.add(OPEN_BODY_CLASS);
    this.dispose = render(() => (
      <ProfileView onAction={(action) => opts?.onAction?.(action)} />
    ), mount);

    appNavigationController.pushItem({
      type: 'svipe-profile',
      onPop: () => {
        this.close(true);
      }
    });
  }

  /** `silent` closes without firing onClose — used when handing off to a
   * slider sub-tab that will return here (the tab bar keeps the highlight). */
  public close(fromPop?: boolean, silent?: boolean) {
    if(!this.dispose) return;

    this.dispose();
    this.dispose = undefined;
    document.body.classList.remove(OPEN_BODY_CLASS);

    if(!fromPop) {
      appNavigationController.removeByType('svipe-profile', true);
    }

    const cb = this.onCloseCb;
    this.onCloseCb = undefined;
    if(!silent) cb?.();
  }
}

const profileController = new ProfileController();
export default profileController;
