import { WebRequest } from 'webextension-polyfill';

import { NetworkRule } from '../rules/network-rule';
import { FilteringLog } from '../filtering-log';
import CookieRulesFinder from './cookie-rules-finder';
import ParsedCookie from './parsed-cookie';
import CookieUtils from './utils';
import BrowserCookieApi from './browser-cookie/browser-cookie-api';
import { CookieModifier } from '../modifiers/cookie-modifier';
import { findHeaderByName } from '../utils/headers';
import { logger } from '../utils/logger';
import OnBeforeRequestDetailsType = WebRequest.OnBeforeRequestDetailsType;
import OnBeforeSendHeadersDetailsType = WebRequest.OnBeforeSendHeadersDetailsType;
import OnHeadersReceivedDetailsType = WebRequest.OnHeadersReceivedDetailsType;
import OnCompletedDetailsType = WebRequest.OnCompletedDetailsType;
import OnErrorOccurredDetailsType = WebRequest.OnErrorOccurredDetailsType;

/**
 * Cookie filtering
 *
 * The following public methods should be set as suitable webrequest events listeners,
 * check sample extension in this repo for an example
 *
 * Logic introduction:
 *
 * onBeforeRequest:
 * - get $cookie rules for current url
 *
 * onBeforeSendHeaders:
 * - get all cookies for request url
 * - store cookies (first-party)
 *
 * onHeadersReceived:
 * - parse set-cookie header, only to detect if the cookie in header will be set from third-party request
 * - save third-party flag for this cookie cookie.thirdParty=request.thirdParty
 * - apply rules via removing them from headers and removing them with browser.cookies api
 * TODO Rewrite/split method for extensions on MV3, because we wont have possibility to remove rules via headers
 *
 * onCompleted/onErrorOccurred:
 * - delete request context from the storage
 *
 * onCompleted
 * - apply rules via content script
 * In content-scripts (check /src/content-script/cookie-controller.ts):
 * - get matching cookie rules
 * - apply
 */
export class CookieFiltering {
    private filteringLog: FilteringLog;

    private browserCookieApi: BrowserCookieApi = new BrowserCookieApi();

    private requestContextStorage = new Map<string, {
        rules: NetworkRule[];
        cookies: ParsedCookie[];
        url: string;
        tabId: number;
    }>();

    /**
     * Constructor
     *
     * @param filteringLog
     */
    constructor(filteringLog: FilteringLog) {
        this.filteringLog = filteringLog;
    }

    /**
     * Finds rules for request and saves it to context storage
     * @param details
     * @param rules
     */
    public onBeforeRequest(details: OnBeforeRequestDetailsType, rules: NetworkRule[]): void {
        this.requestContextStorage.set(details.requestId,
            {
                rules,
                cookies: [],
                url: details.url,
                tabId: details.tabId,
            });
    }

    /**
     * Parses cookies from headers
     * @param details
     */
    public onBeforeSendHeaders(details: OnBeforeSendHeadersDetailsType): void {
        if (!details.requestHeaders) {
            return;
        }

        const context = this.requestContextStorage.get(details.requestId);
        if (!context) {
            return;
        }

        const cookieHeader = findHeaderByName(details.requestHeaders, 'Cookie');
        if (!cookieHeader || !cookieHeader.value) {
            return;
        }

        const cookies = CookieUtils.parseCookies(cookieHeader.value, context.url);
        if (cookies.length === 0) {
            return;
        }

        context.cookies = cookies;
    }

    /**
     * Applies cookies to headers
     * @param details
     * @private
     */
    private applyRulesToCookieHeaders(details: WebRequest.OnHeadersReceivedDetailsType): boolean {
        let headersModified = false;

        if (!details.responseHeaders) {
            return headersModified;
        }

        const context = this.requestContextStorage.get(details.requestId);

        if (!context) {
            return headersModified;
        }

        for (let i = details.responseHeaders.length - 1; i >= 0; i -= 1) {
            const header = details.responseHeaders[i];
            const cookie = CookieUtils.parseSetCookieHeader(header, details.url);

            if (!cookie) {
                continue;
            }

            const bRule = CookieRulesFinder.lookupNotModifyingRule(cookie.name, context.rules, details.thirdParty);

            if (bRule) {
                if (!bRule.isAllowlist()) {
                    details.responseHeaders.splice(i, 1);
                    headersModified = true;
                }

                this.filteringLog.addCookieEvent({
                    tabId: context.tabId,
                    cookieName: cookie.name,
                    cookieValue: cookie.value,
                    cookieDomain: cookie.domain,
                    cookieRule: bRule,
                    isModifyingCookieRule: false,
                    thirdParty: details.thirdParty,
                    timestamp: Date.now(),
                });
            }

            const mRules = CookieRulesFinder.lookupModifyingRules(cookie.name, context.rules, details.thirdParty);
            if (mRules.length > 0) {
                const appliedRules = CookieFiltering.applyRuleToBrowserCookie(cookie, mRules);
                if (appliedRules.length > 0) {
                    headersModified = true;
                    details.responseHeaders[i] =  { name: 'set-cookie', value: CookieUtils.serializeCookie(cookie) };
                    appliedRules.forEach((r) => {
                        this.filteringLog.addCookieEvent({
                            tabId: details.tabId,
                            cookieName: cookie.name,
                            cookieValue: cookie.value,
                            cookieDomain: cookie.domain,
                            cookieRule: r,
                            isModifyingCookieRule: true,
                            thirdParty: details.thirdParty,
                            timestamp: Date.now(),
                        });
                    });
                }
            }
        }

        return headersModified;
    }

    /**
     * Parses set-cookie header
     * looks up third-party cookies
     * This callback won't work for mv3 extensions
     * TODO separate or rewrite to mv2 and mv3 methods
     *
     * @param details
     */
    public onHeadersReceived(details: OnHeadersReceivedDetailsType): boolean {
        const context = this.requestContextStorage.get(details.requestId);
        if (!context) {
            return false;
        }

        if (details.responseHeaders) {
            const cookies = CookieUtils.parseSetCookieHeaders(details.responseHeaders, context.url);
            const newCookies = cookies.filter((c) => !context.cookies.includes(c));
            for (const cookie of newCookies) {
                cookie.thirdParty = details.thirdParty;
            }

            context.cookies.push(...newCookies);
        }

        // remove cookie headers
        // this method won't work in the extension build with manifest v3
        const headersModified = this.applyRulesToCookieHeaders(details);

        // removes cookies with browser.cookie api
        this.applyRules(details.requestId)
            .catch(e => {
                logger.error((e as Error).message);
            });

        return headersModified;
    }

    public onCompleted(details: OnCompletedDetailsType): void {
        this.requestContextStorage.delete(details.requestId);
    }

    public onErrorOccurred(details: OnErrorOccurredDetailsType): void {
        this.requestContextStorage.delete(details.requestId);
    }

    /**
     * Looks up blocking rules for content-script
     *
     * @param requestId
     */
    public getBlockingRules(requestId: string): NetworkRule[] {
        const context = this.requestContextStorage.get(requestId);
        if (!context) {
            return [];
        }

        return CookieRulesFinder.getBlockingRules(context.url, context.rules);
    }

    /**
     * Applies rules
     * @param requestId
     */
    private async applyRules(requestId: string): Promise<void> {
        const context = this.requestContextStorage.get(requestId);
        const { rules, cookies } = context!;
        if (!rules || !cookies) {
            return;
        }

        const promises = cookies.map((cookie) => {
            return this.applyRulesToCookie(cookie, rules, context!.tabId);
        });

        await Promise.all(promises);
    }

    /**
     * Applies rules to cookie
     *
     * @param cookie
     * @param cookieRules
     * @param tabId
     */
    /* istanbul ignore next */
    private async applyRulesToCookie(
        cookie: ParsedCookie,
        cookieRules: NetworkRule[],
        tabId: number,
    ): Promise<void> {
        const cookieName = cookie.name;
        const isThirdPartyCookie = cookie.thirdParty;

        const bRule = CookieRulesFinder.lookupNotModifyingRule(cookieName, cookieRules, isThirdPartyCookie);
        if (bRule) {
            if (bRule.isAllowlist() || await this.browserCookieApi.removeCookie(cookie.name, cookie.url)) {
                this.filteringLog.addCookieEvent({
                    tabId,
                    cookieName: cookie.name,
                    cookieValue: cookie.value,
                    cookieDomain: cookie.domain,
                    cookieRule: bRule,
                    isModifyingCookieRule: false,
                    thirdParty: isThirdPartyCookie,
                    timestamp: Date.now(),
                });
            }

            return;
        }

        const mRules = CookieRulesFinder.lookupModifyingRules(cookieName, cookieRules, isThirdPartyCookie);
        if (mRules.length > 0) {
            const appliedRules = CookieFiltering.applyRuleToBrowserCookie(cookie, mRules);
            if (appliedRules.length > 0) {
                if (await this.browserCookieApi.modifyCookie(cookie)) {
                    appliedRules.forEach((r) => {
                        this.filteringLog.addCookieEvent({
                            tabId,
                            cookieName: cookie.name,
                            cookieValue: cookie.value,
                            cookieDomain: cookie.domain,
                            cookieRule: r,
                            isModifyingCookieRule: true,
                            thirdParty: isThirdPartyCookie,
                            timestamp: Date.now(),
                        });
                    });
                }
            }
        }
    }

    /**
     * Modifies instance of BrowserCookie with provided rules
     *
     * @param cookie Cookie modify
     * @param rules Cookie matching rules
     * @return applied rules
     *
     */
    private static applyRuleToBrowserCookie(cookie: ParsedCookie, rules: NetworkRule[]): NetworkRule[] {
        const appliedRules = [];

        for (let i = 0; i < rules.length; i += 1) {
            const rule = rules[i];
            if (rule.isAllowlist()) {
                appliedRules.push(rule);
                continue;
            }

            const cookieModifier = rule.getAdvancedModifier() as CookieModifier;

            let modified = false;

            const sameSite = cookieModifier.getSameSite();
            if (sameSite && cookie.sameSite !== sameSite) {
                // eslint-disable-next-line no-param-reassign
                cookie.sameSite = sameSite;
                modified = true;
            }

            const maxAge = cookieModifier.getMaxAge();
            if (maxAge) {
                if (CookieUtils.updateCookieMaxAge(cookie, maxAge)) {
                    modified = true;
                }
            }

            if (modified) {
                appliedRules.push(rule);
            }
        }

        return appliedRules;
    }
}
