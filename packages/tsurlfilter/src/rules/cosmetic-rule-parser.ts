import * as utils from '../utils/utils';
import { COMMA_SEPARATOR, DomainModifier, PIPE_SEPARATOR } from '../modifiers/domain-modifier';
import { findCosmeticRuleMarker } from './cosmetic-rule-marker';
import { CosmeticRuleModifiers, CosmeticRuleModifiersSyntax } from './cosmetic-rule-modifiers';
import { SimpleRegex } from './simple-regex';

const cosmeticRuleModifiersList = Object.values(CosmeticRuleModifiers) as string[];

export type CosmeticRuleModifiersCollection = {
    [P in CosmeticRuleModifiers]?: string;
};

/**
 * Helper class for parsing text of cosmetic rules
 * used by CosmeticRule and [Filter compiler](https://github.com/AdguardTeam/FiltersCompiler)
 *
 *
 * The cosmetic rule contains of the following parts:
 *
 * `pattern##content`
 *
 * `pattern` contains the list of the rule modifiers and domains.
 *
 * `##` is a marker (might be a different marker depending on the rule type).
 * You can find the list of markers in the CosmeticRuleMarker enumeration.
 *
 * `content` might be a CSS selector, a scriptlet or something else, depending on the rule type.
 */
export class CosmeticRuleParser {
    /**
     * Parse the rule's pattern, cosmetic marker and the content parts from the rule text.
     * If the content is empty, throws a SyntaxError.
     *
     * @param ruleText
     * @returns Object with pattern, marker and content text parts
     */
    static parseRuleTextByMarker(ruleText: string): {
        pattern?: string;
        marker: string;
        content: string;
    } {
        const [markerIndex, marker] = findCosmeticRuleMarker(ruleText);

        if (marker === null) {
            throw new SyntaxError('Not a cosmetic rule');
        }

        const content = ruleText.substring(markerIndex + marker.length).trim();

        if (!content) {
            throw new SyntaxError('Rule content is empty');
        }

        let pattern;

        if (markerIndex > 0) {
            pattern = ruleText.substring(0, markerIndex);
        }

        return {
            pattern,
            marker,
            content,
        };
    }

    /**
     * Extracts the rule modifiers and domains from the rule pattern.
     * @param rulePattern
     * @returns Object with modifiers and domains text parts
     */
    static parseRulePatternText(rulePattern: string): {
        domainsText?: string;
        modifiersText?: string;
    } {
        const {
            OPEN_BRACKET,
            CLOSE_BRACKET,
            SPECIAL_SYMBOL,
            ESCAPE_CHARACTER,
        } = CosmeticRuleModifiersSyntax;

        if (!rulePattern.startsWith(`${OPEN_BRACKET + SPECIAL_SYMBOL}`)) {
            return { domainsText: rulePattern };
        }

        let closeBracketIndex;

        // The first two characters cannot be closing brackets
        for (let i = 2; i < rulePattern.length; i += 1) {
            if (rulePattern[i] === CLOSE_BRACKET && rulePattern[i - 1] !== ESCAPE_CHARACTER) {
                closeBracketIndex = i;
                break;
            }
        }

        if (!closeBracketIndex) {
            throw new SyntaxError('Can\'t parse modifiers list');
        }

        // Handle this case: `[$]`
        if (closeBracketIndex === 2) {
            throw new SyntaxError('Modifiers list can\'t be empty');
        }

        const modifiersText = rulePattern.slice(2, closeBracketIndex);

        let domainsText;

        if (closeBracketIndex < rulePattern.length - 1) {
            domainsText = rulePattern.slice(closeBracketIndex + 1);
        }

        return {
            modifiersText,
            domainsText,
        };
    }

    /**
     * Parses the list of modifiers. Parsing is done in the same way as it's done in the NetworkRule, i.e.
     * we have a comma-separated list of modifier-value pairs.
     * If we encounter an invalid modifier, this method throws a SyntaxError.
     *
     * @param modifiersText - list of modifiers splited by comma
     * @returns - modifiers collection object
     */
    static parseRuleModifiers(modifiersText: string | undefined): CosmeticRuleModifiersCollection | null {
        if (!modifiersText) {
            return null;
        }

        const {
            ESCAPE_CHARACTER,
            DELIMITER,
            ASSIGNER,
        } = CosmeticRuleModifiersSyntax;

        const modifiersTextArray = utils.splitByDelimiterWithEscapeCharacter(
            modifiersText,
            DELIMITER,
            ESCAPE_CHARACTER,
            false,
            false,
        );

        const modifiers = Object.create(null);

        for (let i = 0; i < modifiersTextArray.length; i += 1) {
            const modifierText = modifiersTextArray[i];
            const assignerIndex = modifierText.indexOf(ASSIGNER);

            if (modifierText === 'path') {
                // Empty path modifier without assigner and value will match only main page
                modifiers[modifierText] = '';
                continue;
            }

            if (assignerIndex === -1) {
                throw new SyntaxError('Modifier must have assigned value');
            }

            const modifierKey = modifierText.substring(0, assignerIndex);

            if (cosmeticRuleModifiersList.includes(modifierKey)) {
                const modifierValue = modifierText.substring(assignerIndex + 1);

                modifiers[modifierKey] = modifierValue;
            } else {
                throw new SyntaxError(`'${modifierKey}' is not valid modifier`);
            }
        }

        return modifiers;
    }

    /**
     * Parses the rule pattern and extracts the permitted/restricted domains and the unescaped path modifier value,
     * If domains are declared through $domain modifier and pattern domain list, this method throws a SyntaxError.
     * @param rulePattern - rule pattern text
     *
     * @returns Object with permitted/restricted domains list and the path modifier string value
     */
    static parseRulePattern(rulePattern: string): {
        path?: string;
        permittedDomains?: string[];
        restrictedDomains?: string[];
    } {
        const {
            domainsText,
            modifiersText,
        } = CosmeticRuleParser.parseRulePatternText(rulePattern);

        let domains = domainsText;
        let path;

        const modifiers = CosmeticRuleParser.parseRuleModifiers(modifiersText);

        if (modifiers) {
            if (modifiers.path || modifiers.path === '') {
                path = modifiers.path;

                if (SimpleRegex.isRegexPattern(path)) {
                    path = SimpleRegex.unescapeRegexSpecials(
                        path,
                        SimpleRegex.reModifierPatternEscapedSpecialCharacters,
                    );
                }
            }

            if (modifiers.domain) {
                if (domains) {
                    throw new SyntaxError('The $domain modifier is not allowed in a domain-specific rule');
                } else {
                    domains = modifiers.domain;
                }
            }
        }

        let permittedDomains;
        let restrictedDomains;

        // Skip wildcard domain
        if (domains && domains !== SimpleRegex.MASK_ANY_CHARACTER) {
            const separator = modifiers?.domain ? PIPE_SEPARATOR : COMMA_SEPARATOR;
            const domainModifier = new DomainModifier(domains, separator);

            if (domainModifier.permittedDomains) {
                permittedDomains = domainModifier.permittedDomains;
            }

            if (domainModifier.restrictedDomains) {
                restrictedDomains = domainModifier.restrictedDomains;
            }
        }

        return {
            path,
            permittedDomains,
            restrictedDomains,
        };
    }
}
