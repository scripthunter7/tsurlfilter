import { ExtendedCss } from '@adguard/extended-css';
import { CssHitsCounter } from './css-hits-counter';
import CookieController from './cookie-controller';
import StealthHelper from '../stealth/stealth-helper';

/**
 * This module exports libraries used in the extension via content scripts
 */
export default {
    ExtendedCss,
    CssHitsCounter,
    CookieController,
    StealthHelper,
};
