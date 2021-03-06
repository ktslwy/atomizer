/*
 * Copyright (c) 2015, Yahoo Inc. All rights reserved.
 * Copyrights licensed under the New BSD License.
 * See the accompanying LICENSE file for terms.
 */

/**
 * @TODO:
 * - Try using immutable.js for rules.
 * - don't require the entire lodash lib, just what we're using.
 * - implement getConfig() so we can export a merged config.
 * - validate config? maybe we need it.
 * - GRAMMAR/SYNTAX needs to handle some edge cases, specifically in regards to word boundaries.
 * - check how much memory this program is using, check if we could potentially run out of memory
 *   because of the lengthy regex.
 * - replace Absurd() with something simpler, it does too much and it's slow.
 */

'use strict';

var _ = require('lodash');
var utils = require('./utils');
var objectAssign = require('object-assign');
var Absurd = require('absurd');
var XRegExp = require('xregexp').XRegExp;

var RULES = require('./rules.js').concat(require('./helpers.js'));

var PSEUDOS = {
    ':active':          ':a',
    ':checked':         ':c',
    ':default':         ':d',
    ':disabled':        ':di',
    ':empty':           ':e',
    ':enabled':         ':en',
    ':first':           ':fi',
    ':first-child':     ':fc',
    ':first-of-type':   ':fot',
    ':fullscreen':      ':fs',
    ':focus':           ':f',
    ':hover':           ':h',
    ':indeterminate':   ':ind',
    ':in-range':        ':ir',
    ':invalid':         ':inv',
    ':last-child':      ':lc',
    ':last-of-type':    ':lot',
    ':left':            ':l',
    ':link':            ':li',
    ':only-child':      ':oc',
    ':only-of-type':    ':oot',
    ':optional':        ':o',
    ':out-of-range':    ':oor',
    ':read-only':       ':ro',
    ':read-write':      ':rw',
    ':required':        ':req',
    ':right':           ':r',
    ':root':            ':rt',
    ':scope':           ':s',
    ':target':          ':t',
    ':valid':           ':va',
    ':visited':         ':vi'
};
var PSEUDOS_INVERTED = _.invert(PSEUDOS);
var PSEUDO_REGEX = [];
for (var pseudo in PSEUDOS) {
    PSEUDO_REGEX.push(pseudo);
    PSEUDO_REGEX.push(PSEUDOS[pseudo]);
}
PSEUDO_REGEX = '(?:' + PSEUDO_REGEX.join('|') + ')';

// regular grammar to match valid atomic classes
var GRAMMAR = {
    'BOUNDARY'   : '(?:^|\\s|"|\'|\{)',
    'PARENT'     : '[^\\s:>_]+',
    'PARENT_SEP' : '[>_]',
    'FRACTION'   : '(?<numerator>[0-9]+)\\/(?<denominator>[1-9](?:[0-9]+)?)',
    'PARAMS'     : '\\((?<params>(?:.*?,?)+)\\)',
    'SIGN'       : 'neg',
    'NUMBER'     : '[0-9]+(?:\\.[0-9]+)?',
    'UNIT'       : '[a-zA-Z%]+',
    'HEX'        : '#[0-9a-f]{3}(?:[0-9a-f]{3})?',
    'ALPHA'      : '\\.\\d{1,2}',
    'IMPORTANT'  : '!',
    // https://regex101.com/r/mM2vT9/7
    'NAMED'      : '(\\w+(?:(?:-(?!\\-))?\\w*)*)',
    'PSEUDO'     : PSEUDO_REGEX,
    'BREAKPOINT' : '--(?<breakPoint>[a-z]+)'
};
GRAMMAR.PARENT_SELECTOR = [
    // parent (any character that is not a space)
    '(?<parent>',
        GRAMMAR.PARENT,
    ')',
    // followed by optional pseudo class
    '(?<parentPseudo>',
        GRAMMAR.PSEUDO,
    ')?',
    // followed by either a descendant or direct symbol
    '(?<parentSep>',
        GRAMMAR.PARENT_SEP,
    ')'
].join('');

/*
// -----------------------------------
// INTERFACE
// -----------------------------------

// Atomizer Options
// options for the behavior of the atomizer class (not the CSS output)
interface AtomizerOptions {
    verbose:boolean;
}

// Atomizer Rules
// rules are expected to be in the following format
interface AtomizerRules {
    [index:number]:AtomizerRule
}
interface AtomizerRule {
    allowCustom:boolean;
    allowSuffixToValue:boolean;
    id:string;
    name:string;
    prefix:string;
    properties:string;
    type:string;
}

// AtomizerConfig
// the config that contains additional info to create atomic classes
interface AtomizerConfig {
    custom?: {[index:string]:string};
    breakPoints?: {[index:string]:string};
    classNames: string[];
}

// CssOptions
// general options that affect the CSS output
interface CssOptions {
    namespace?:string;
    rtl?:boolean;
}

// AtomicTree
// the parse tree is generated after a class is parsed.
// it's an object where its keys are mapped to AtomizerRules.ids
// and value is an array of objects containing structured data about
// the class name.
interface AtomicTree {
    [index:string]:AtomicTreeArray;
}
interface AtomicTreeArray {
    [index:number]:AtomicTreeObject;
}
interface AtomicTreeObject {
    breakPoint?:string;
    className:string;
    context?:AtomicTreeContext;
    pseudo?:string;
    value:AtomicTreeValue;
}
interface AtomicTreeContext {
    directParent:boolean;
    parent:string;
}
interface AtomicTreeValue {
    percentage?:number;
    fraction:string;
    color:string;
    value:string;
}
*/

/**
 * constructor
 */
function Atomizer(options/*:AtomizerOptions*/, rules/*:AtomizerRules*/) {
    this.verbose = options && options.verbose || false;
    this.rules = [];
    this.rulesMap = {};
    this.helpersMap = {};

    // add rules
    this.addRules(rules || RULES);
}

Atomizer.prototype.addRules = function(rules/*:AtomizerRules*/)/*:void*/ {

    rules.forEach(function (rule) {
        if (this.rulesMap.hasOwnProperty(rule.prefix)) {
            throw new Error('Rule ' + rule.prefix + ' already exists');
        }

        // push new rule to this.rules and update rulesMap
        this.rules.push(rule);

        if (rule.type === 'pattern') {
            this.rulesMap[rule.prefix] = this.rules.length - 1;
        } else {
            this.helpersMap[rule.prefix] = this.rules.length - 1;
        }
    }, this);

    // invalidates syntax
    this.syntax = null;
};

/**
 * getSyntax()
 * we combine the regular expressions here. since we're NOT doing a lexical
 * analysis of the entire document we need to use regular grammar for this.
 * @private
 */
Atomizer.prototype.getSyntax = function ()/*:void*/ {
    var syntax;
    var helperRegex;
    var propRegex;
    var helpersKeys;
    var rulesKeys;
    var mainSyntax;

    if (this.syntax) {
        return this.syntax;
    } else {
        helpersKeys = Object.keys(this.helpersMap);
        rulesKeys = Object.keys(this.rulesMap);

        // helpers regex
        if (helpersKeys.length) {            
            helperRegex = [
                // prefix
                '(?<helper>' + helpersKeys.join('|') + ')',
                // required param ()
                GRAMMAR.PARAMS
            ].join('');
            mainSyntax = helperRegex;
        }
        // rules regex
        if (rulesKeys.length) {
            propRegex = [
                // prefix
                '(?<prop>' + rulesKeys.join('|') + ')',
                // required value
                '(?<value>',
                    '(?<fraction>',
                        GRAMMAR.FRACTION,
                    ')',
                    '|',
                    '(?:',
                        '(?<hex>',
                            GRAMMAR.HEX,
                        ')',
                        '(?<alpha>',
                            GRAMMAR.ALPHA,
                        ')?',
                        '(?!',
                            GRAMMAR.UNIT,
                        ')',
                    ')',
                    '|',
                    '(?<sign>',
                        GRAMMAR.SIGN,
                    ')?',
                    '(?<number>',
                        GRAMMAR.NUMBER,
                    ')',
                    '(?<unit>',
                        GRAMMAR.UNIT,
                    ')?',
                    '|',
                    '(?<named>',
                        GRAMMAR.NAMED,
                    ')',
                ')',
                '(?<important>',
                    GRAMMAR.IMPORTANT,
                ')?',
            ].join('');
            mainSyntax = propRegex;
        }

        if (helpersKeys.length && rulesKeys.length) {
            mainSyntax = ['(?:', helperRegex , '|', propRegex,')'].join('');
        }

        syntax = [
            // word boundary
            GRAMMAR.BOUNDARY,
            // optional parent
            '(?<parentSelector>',
                GRAMMAR.PARENT_SELECTOR,
            ')?',
            mainSyntax,
            // optional pseudo
            '(?<valuePseudo>',
                GRAMMAR.PSEUDO,
            ')?',
            // optional modifier
            '(?:',
                GRAMMAR.BREAKPOINT,
            ')?'
        ].join('');

        this.syntax = XRegExp(syntax, 'g');

        return this.syntax;
    }
};

/**
 * findClassNames
 */
Atomizer.prototype.findClassNames = function (src/*:string*/)/*:string[]*/ {
    // using object to remove dupes
    var classNamesObj = {};
    var className;
    var syntaxRegex = this.getSyntax();
    var match = syntaxRegex.exec(src);

    while (match !== null) {
        // strip boundary character
        className = match[0].substr(1);
        // assign to classNamesObj as key and give it a counter
        classNamesObj[className] = classNamesObj[className] ? classNamesObj[className] + 1 : 1;
        // run regex again
        match = syntaxRegex.exec(src);
    }

    // return an array of the matched class names
    return _.keys(classNamesObj);
};

/**
 * Get Atomizer config given an array of class names and an optional config object
 * examples:
 *
 * getConfig(['Op-1', 'D-n:h', 'Fz-heading'], {
 *     custom: {
 *         heading: '80px'
 *     },
 *     breakPoints: {
 *         'sm': '@media(min-width:500px)',
 *         'md': '@media(min-width:900px)',
 *         'lg': '@media(min-width:1200px)'
 *     },
 *     classNames: ['D-b']
 * }, {
 *     rtl: true
 * });
 *
 * getConfig(['Op-1', 'D-n:h']);
 */
Atomizer.prototype.getConfig = function (classNames/*:string[]*/, config/*:AtomizerConfig*/)/*:AtomizerConfig*/ {
    config = config || { classNames: [] };
    // merge classnames with config
    config.classNames = _.union(classNames || [], config.classNames);
    return config;
};

/**
 * Get CSS given an array of class names, a config and css options.
 * examples:
 *
 * getCss({
 *     custom: {
 *         heading: '80px'
 *     },
 *     breakPoints: {
 *         'sm': '@media(min-width:500px)',
 *         'md': '@media(min-width:900px)',
 *         'lg': '@media(min-width:1200px)'
 *     },
 *     classNames: ['D-b', 'Op-1', 'D-n:h', 'Fz-heading']
 * }, {
 *     rtl: true
 * });
 *
 */
Atomizer.prototype.getCss = function (config/*:AtomizerConfig*/, options/*:CSSOptions*/)/*:string*/ {
    var matches;
    var tree/*:AtomicTree*/ = {};
    var csso = {};
    var cssoHelpers = {};
    var absurd = Absurd();
    var content = '';
    var warnings = [];
    var isVerbose = !!this.verbose;
    var syntaxRegex = this.getSyntax();
    var breakPoints;

    options = objectAssign({}, {
        // require: [],
        // morph: null,
        banner: '',
        namespace: null,
        rtl: false
    }, options);

    // validate config.breakPoints
    if (config && config.breakPoints) {
        if (!_.isObject(config.breakPoints)) {
            throw new TypeError('`config.breakPoints` must be an Object');
        }
        /* istanbul ignore else  */
        if (_.size(config.breakPoints) > 0) {
            for(var bp in config.breakPoints) {
                if (!/^@media/.test(config.breakPoints[bp])) {
                    throw new Error('Breakpoint `' + bp + '` must start with `@media`.');
                } else {
                    breakPoints = config.breakPoints;
                }
            }
        }
    }

    // each match is a valid class name
    config.classNames.forEach(function (className) {
        var match = XRegExp.exec(className, syntaxRegex);
        var namedFound = false;
        var rule;
        var treeo;
        var ruleIndex;
        var rgb;
        var propAndValue;

        if (!match) {
          return '';
        }

        ruleIndex = match.prop ? this.rulesMap[match.prop] : this.helpersMap[match.helper];

        // get the rule that this class name belongs to.
        // this is why we created the dictionary
        // as it will return the index given an prefix.
        rule = this.rules[ruleIndex];
        treeo = {
            className: match[0]
        };

        if (!tree[rule.prefix]) {
            tree[rule.prefix] = [];
        }

        if (match.parentSelector) {
            treeo.parentSelector = match.parentSelector;
        }
        if (match.parent) {
            treeo.parent = match.parent;
        }
        if (match.parentPseudo) {
            treeo.parentPseudo = match.parentPseudo;
        }
        if (match.parentSep) {
            treeo.parentSep = match.parentSep;
        }
        if (match.value) {
            // is this a valid value?
            if (rule.allowSuffixToValue) {
                treeo.value = match.value;
            } else {
                match.named = match.value;
            }
        }
        if (match.params) {
            treeo.params = match.params.split(',');
        }
        if (match.fraction) {
            // multiplying by 100 then by 10000 on purpose (instead of just multiplying by 1M),
            // making clear the steps involved:
            // percentage: (numerator / denominator * 100)
            // 4 decimal places:  (Math.round(percentage * 10000) / 10000)
            treeo.value = Math.round(match.numerator / match.denominator * 100 * 10000) / 10000 + '%';
        }
        if (match.sign) {
            treeo.value = treeo.value.replace(GRAMMAR.SIGN, '-');
        }

        if (match.hex) {
            if (match.alpha) {
                rgb = utils.hexToRgb(match.hex);
                treeo.value = [
                    'rgba(',
                    rgb.r,
                    ',',
                    rgb.g,
                    ',',
                    rgb.b,
                    ',',
                    match.alpha,
                    ')'
                ].join('');
            } else {
                treeo.value = match.hex;
            }
        }
        if (match.named) {
            treeo.named = match.named;

            // check if the named suffix matches any of
            // the suffixes registered in rules.
            if (rule.rules) {
                // iterate rules
                rule.rules.some(function (keywordRule, index) {
                    // if we find it, then add declaration
                    if (keywordRule.suffix === match.named) {
                        // build declaration (iterate prop the value)
                        rule.properties.forEach(function (property) {
                            keywordRule.values.forEach(function (value) {
                                /* istanbul ignore else */
                                if (!treeo.declaration) {
                                    treeo.declaration = {};
                                }
                                treeo.declaration[property] = value;
                                if (match.important) {
                                    treeo.declaration[property] += ' !important';
                                }
                            });
                        });
                        namedFound = true;
                        return true;
                    }
                });
            }
            // check if named suffix was passed in the config
            // as value
            if (!namedFound) {
                propAndValue = match.prop + match.named;

                // no custom, warn it
                if (!config.custom) {
                    warnings.push(propAndValue);
                    // set to null so we don't write it to the css
                    treeo.value = null;
                }
                // as prop + value
                else if (config.custom.hasOwnProperty(propAndValue)) {
                    treeo.value = config.custom[propAndValue];
                }
                // as value
                else if (config.custom.hasOwnProperty(match.named)) {
                    treeo.value = config.custom[match.named];
                }
                // we have custom but we could not find the named class name there
                else {
                    warnings.push(propAndValue);
                    // set to null so we don't write it to the css
                    treeo.value = null;
                }
            }
        }
        if (match.valuePseudo) {
            treeo.valuePseudo = match.valuePseudo;
        }

        if (match.breakPoint) {
            treeo.breakPoint = match.breakPoint;
        }
        if (match.important) {
            treeo.value = treeo.value + ' !important';
        }

        tree[rule.prefix].push(treeo);

    }, this);

    // throw warnings
    if (isVerbose && warnings.length > 0) {
        warnings.forEach(function (className) {
            console.warn([
                'Warning: Class `' + className + '` is ambiguous, and must be manually added to your config file:',
                '"custom": {',
                '    "' + className + '": <YOUR-CUSTOM-VALUE>',
                '}'
            ].join("\n"));
        });
    }

    // write CSSO
    // start by iterating rules (we need to follow the order that the rules were declared)
    this.rules.forEach(function (rule) {
        var className;
        var treeCurrent;

        // check if we have a class name that matches this rule
        if (tree[rule.prefix]) {
            tree[rule.prefix].forEach(function(treeo) {
                var breakPoint = breakPoints && breakPoints[treeo.breakPoint];

                // this is where we start writing the class name, properties and values
                className = Atomizer.escapeSelector(treeo.className);

                // handle parent classname
                if (treeo.parentSelector) {
                    className = [
                        Atomizer.escapeSelector(treeo.parent),
                        Atomizer.getPseudo(treeo.parentPseudo),
                        treeo.parentSep !== '>' ? ' ' : treeo.parentSep,
                        '.',
                        className
                    ].join('');
                }

                // handle pseudo in values
                if (treeo.valuePseudo) {
                    className = [
                        className,
                        Atomizer.getPseudo(treeo.valuePseudo)
                    ].join('');
                }

                // add the dot for the class
                className = ['.', className].join('');

                // fix the comma problem in Absurd
                // @TODO temporary until we replace Absurd
                // See also the return of this method.
                className = className.replace(',', '__COMMA__');

                // finaly, create the object

                // helper rules doesn't have the same format as patterns
                if (rule.type === 'helper') {
                    cssoHelpers[className] = {};

                    if (breakPoint) {
                        cssoHelpers[className][breakPoint] = {};
                    }
                    if (!rule.declaration) {
                        throw new Error('Declaration key is expected in a helper class. Helper class: ' + rule.prefix);
                    }

                    if (breakPoint) {
                        cssoHelpers[className][breakPoint] = rule.declaration;
                    } else {
                        cssoHelpers[className] = rule.declaration;
                    }

                    // we have params in declaration
                    if (treeo.params) {
                        treeo.params.forEach(function (param, index) {
                            if (breakPoint) {
                                for (var prop in cssoHelpers[className][breakPoint]) {
                                    cssoHelpers[className][breakPoint][prop] = cssoHelpers[className][breakPoint][prop].replace('$' + index, param);
                                }
                            } else {
                                for (var prop in cssoHelpers[className]) {
                                    cssoHelpers[className][prop] = cssoHelpers[className][prop].replace('$' + index, param);
                                }
                            }
                        });
                    }
                    if (rule.rules) {
                        _.merge(csso, rule.rules);
                    }
                } else/* if (type === 'pattern')*/ {
                    csso[className] = {};

                    if (breakPoint) {
                        csso[className][breakPoint] = {};
                    }

                    // named classes have their property/value already assigned
                    if (treeo.declaration) {
                        if (breakPoint) {
                            csso[className][breakPoint] = treeo.declaration;
                        } else {
                            csso[className] = treeo.declaration;
                        }
                    }
                    // a custom class name not declared in the config might not have values
                    else if (treeo.value) {
                        rule.properties.forEach(function (property) {
                            var value = treeo.value;
                            if (breakPoint) {
                                csso[className][breakPoint][property] = value;
                            } else {
                                csso[className][property] = value;
                            }
                        });
                    }
                }
            });
        }
    });

    // Pass some options through to Absurd
    // if (options.morph) {
    //     api.morph(options.morph);
    // }

    // if (options.require.length > 0) {
    //     api.import(options.require);
    // }

    if (options.namespace) {
        var cssoNew = {};
        cssoNew[options.namespace] = csso;
        csso = cssoNew;
    }
    if (options.helpersNS) {
        var cssoHelpersNew = {};
        cssoHelpersNew[options.helpersNS] = cssoHelpers;
        cssoHelpers = cssoHelpersNew;
    }

    _.merge(csso, cssoHelpers);

    // send CSSO to absurd
    absurd.add(csso);
    absurd.compile(function(err, result) {
        /* istanbul ignore if else */
        if (err) {
            throw new Error('Failed to compile atomic css:' + err);
        }
        content = options.banner + result;
    }, options);

    // fix the comma problem in Absurd
    content = content.replace(/__COMMA__/g, ',');
    content = Atomizer.replaceConstants(content, options.rtl);

    return content;
};

/**
 * get non abbreviated pseudo class string given abbreviated or non abbreviated form
 */
Atomizer.getPseudo = function (pseudoName/*:string*/)/*:string*/ {
    return PSEUDOS[pseudoName] ? pseudoName : PSEUDOS_INVERTED[pseudoName];
};

/**
 * Escape CSS selectors with a backslash
 * e.g. ".W-100%" => ".W-100\%"
 */
Atomizer.escapeSelector = function (str/*:string*/)/*:string*/ {
    if (!str && str !== 0) {
        throw new TypeError('str must be present');
    }

    if (str.constructor !== String) {
        return str;
    }

    // TODO: maybe find a better regex? (-?) is here because '-' is considered a word boundary
    // so we get it and put it back to the string.
    return str.replace(/\b(-?)([^-_a-zA-Z0-9\s]+)/g, function (str, dash, characters) {
        return dash + characters.split('').map(function (character) {
            return ['\\', character].join('');
        }).join('');
    });
};

/**
 * Replace LTR/RTL placeholders with actual left/right strings
 */
Atomizer.replaceConstants = function (str/*:string*/, rtl/*:boolean*/) {
    var start = rtl ? 'right' : 'left';
    var end = rtl ? 'left' : 'right';

    if (!str || str.constructor !== String) {
        return str;
    }

    return str.replace(/__start__/g, start).replace(/__end__/g, end);
};

module.exports = Atomizer;
