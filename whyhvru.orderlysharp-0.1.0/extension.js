"use strict";
const vscode = require("vscode");

const MemberType = Object.freeze({
    PublicConst: "public const",
    PrivateConst: "private const",
    ReadonlyField: "readonly field",
    SerializeField: "serialize field",
    PrivateField: "private field",
    PublicField: "public field",
    Property: "property",
    Event: "event",
    UnityMethod: "unity method",
    PublicMethod: "public method",
    PrivateMethod: "private method"
});

const UNITY_METHODS = new Set([
    'Awake', 'Start', 'Update', 'FixedUpdate', 'LateUpdate',
    'OnEnable', 'OnDisable', 'OnDestroy', 'OnValidate',
    'OnTriggerEnter', 'OnTriggerEnter2D', 'OnTriggerExit', 'OnTriggerExit2D',
    'OnTriggerStay', 'OnTriggerStay2D', 'OnCollisionEnter', 'OnCollisionEnter2D',
    'OnCollisionExit', 'OnCollisionExit2D', 'OnCollisionStay', 'OnCollisionStay2D',
    'OnMouseDown', 'OnMouseUp', 'OnMouseEnter', 'OnMouseExit', 'OnMouseOver'
]);

const CONST_REGEX = /^(public|private)\s+const\s+/;
const READONLY_FIELD_REGEX = /^(?:\w+\s+)*readonly\s+\w/;
const FIELD_REGEX = /^(private|public)\s+(?!readonly)(?:\w+\s+)*[\w<>,\[\]\s]+\s+\w+\s*(?:=|;|\s*$)/;
const AUTO_PROPERTY_REGEX = /{\s*get;\s*(?:private\s+)?set;\s*}/;
const PROPERTY_REGEX = /^\s*(?:public|private|internal|protected)?\s*(?:\w+\s+)*[\w<>,\[\]\s]+\s+\w+\s*{\s*[^{}]*get[^{}]*\}[^{}]*{|{\s*get\s*[^{}]*}/;
const ARROW_PROPERTY_REGEX = /^\s*(?:public|private|internal|protected)?\s*(?:\w+\s+)*[\w<>,\[\]\s]+\s+\w+\s*=>/;
const EVENT_REGEX = /^\s*(?:public|private|protected|internal)?\s*event\s+/;
const METHOD_REGEX = /^(?:public|private|protected|internal)?\s*(?:static\s+)?(?:async\s+)?(?:virtual\s+|override\s+|sealed\s+|extern\s+)?(?:readonly\s+)?[\w<>,\[\]\s]+\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:\{|;|\=\>)/;

class PerformanceAnalyzer {
    constructor(configOrder) {
        this._orderMap = new Map(configOrder.map((type, index) => [type, index]));
        this._order = configOrder;
        this._cache = new Map();
    }

    analyzeDocument(document) {
        if (!this._isCSharpDocument(document)) return [];

        const cacheKey = document.uri.toString() + ':' + document.version;
        const cached = this._cache.get(cacheKey);
        if (cached) return cached;

        const text = document.getText();
        const diagnostics = this._analyzeText(text, document);

        this._cache.set(cacheKey, diagnostics);
        if (this._cache.size > 50) {
            const firstKey = this._cache.keys().next().value;
            this._cache.delete(firstKey);
        }

        return diagnostics;
    }

    _isCSharpDocument(document) {
        return document.languageId === 'csharp' || document.fileName?.endsWith('.cs');
    }

    _analyzeText(text, document) {
        const classRanges = this._findClassRanges(text);
        if (classRanges.length === 0) return [];

        const diagnostics = [];
        const lines = text.split(/\r?\n/);

        for (const range of classRanges) {
            const members = this._parseClassMembers(lines, range);
            diagnostics.push(...this._validateMemberOrder(members, lines));
        }

        return diagnostics;
    }

    _findClassRanges(text) {
        const ranges = [];
        const classRegex = /^\s*(?:public|private|internal|protected)?\s*(?:partial\s+)?(?:abstract\s+)?(?:sealed\s+)?(class|struct|record|interface)\s+(\w+)/gm;

        let match;
        while ((match = classRegex.exec(text)) !== null) {
            const classStart = this._getLineNumber(text, match.index);
            const braceStart = text.indexOf('{', match.index);
            if (braceStart === -1) continue;

            const classRange = this._findClassBodyRange(text, braceStart);
            if (classRange) {
                ranges.push(classRange);
            }
        }

        return ranges;
    }

    _getLineNumber(text, position) {
        return text.substring(0, position).split('\n').length - 1;
    }

    _findClassBodyRange(text, braceStart) {
        let braceCount = 1;
        let currentPos = braceStart + 1;

        while (currentPos < text.length && braceCount > 0) {
            const char = text[currentPos];
            if (char === '{') braceCount++;
            else if (char === '}') braceCount--;
            currentPos++;
        }

        if (braceCount === 0) {
            const startLine = this._getLineNumber(text, braceStart);
            const endLine = this._getLineNumber(text, currentPos - 1);
            return { start: startLine, end: endLine };
        }

        return null;
    }

    _parseClassMembers(lines, range) {
        const members = [];
        let currentLine = range.start;
        let inMultiLineComment = false;
        let pendingSerializeField = false;

        while (currentLine <= range.end) {
            let line = lines[currentLine].trim();

            if (!line) {
                currentLine++;
                continue;
            }

            if (inMultiLineComment) {
                if (line.includes('*/')) {
                    inMultiLineComment = false;
                    line = line.substring(line.indexOf('*/') + 2).trim();
                } else {
                    currentLine++;
                    continue;
                }
            }

            if (line.startsWith('//')) {
                currentLine++;
                continue;
            }

            if (line.startsWith('/*')) {
                inMultiLineComment = true;
                const commentEnd = line.indexOf('*/');
                if (commentEnd !== -1) {
                    inMultiLineComment = false;
                    line = line.substring(commentEnd + 2).trim();
                } else {
                    currentLine++;
                    continue;
                }
            }

            if (line.startsWith('[')) {
                const hasSerializeField = /\[\s*SerializeField\s*\]/i.test(line);

                const bracketEnd = line.indexOf(']');
                if (bracketEnd !== -1) {
                    const afterBracket = line.substring(bracketEnd + 1).trim();
                    if (afterBracket) {
                        line = afterBracket;
                        if (hasSerializeField) {
                            pendingSerializeField = true;
                        }
                    } else {
                        if (hasSerializeField) {
                            pendingSerializeField = true;
                        }
                        currentLine++;
                        continue;
                    }
                } else {
                    if (hasSerializeField) {
                        pendingSerializeField = true;
                    }
                    currentLine++;
                    continue;
                }
            }

            let fullDeclaration = line;
            let nextLine = currentLine + 1;

            while (nextLine <= range.end && this._isIncompleteDeclaration(fullDeclaration)) {
                const nextLineContent = lines[nextLine].trim();
                if (!nextLineContent || nextLineContent.startsWith('//') || nextLineContent.startsWith('[')) break;

                fullDeclaration += ' ' + nextLineContent;
                nextLine++;
            }

            const memberType = this._classifyMember(fullDeclaration, pendingSerializeField);
            if (memberType) {
                const memberName = this._extractMemberName(fullDeclaration, memberType);
                members.push({
                    name: memberName,
                    type: memberType,
                    line: currentLine
                });
            }

            if (pendingSerializeField) {
                pendingSerializeField = false;
            }

            currentLine = nextLine;
        }

        return members;
    }

    _isIncompleteDeclaration(declaration) {
        return !/[;{}]/.test(declaration) &&
            !declaration.includes('{ get;') &&
            !declaration.includes('=>');
    }

    _classifyMember(declaration, hasSerializeField) {
        const normalized = declaration.replace(/\s+/g, ' ').trim();

        if (CONST_REGEX.test(normalized)) {
            return normalized.startsWith('public') ? MemberType.PublicConst : MemberType.PrivateConst;
        }

        if (READONLY_FIELD_REGEX.test(normalized) && !normalized.includes(' const ')) {
            return MemberType.ReadonlyField;
        }

        if (hasSerializeField) {
            return MemberType.SerializeField;
        }

        if (EVENT_REGEX.test(normalized)) {
            return MemberType.Event;
        }

        if (AUTO_PROPERTY_REGEX.test(normalized) ||
            PROPERTY_REGEX.test(normalized) ||
            ARROW_PROPERTY_REGEX.test(normalized)) {
            return MemberType.Property;
        }

        if (FIELD_REGEX.test(normalized)) {
            return normalized.startsWith('private') ? MemberType.PrivateField : MemberType.PublicField;
        }

        if (this._isMethodDeclaration(normalized)) {
            const methodMatch = normalized.match(METHOD_REGEX);
            if (methodMatch) {
                const methodName = methodMatch[1];

                if (UNITY_METHODS.has(methodName)) {
                    return MemberType.UnityMethod;
                }

                if (normalized.startsWith('public')) {
                    return MemberType.PublicMethod;
                }

                return MemberType.PrivateMethod;
            }
        }

        return null;
    }

    _isMethodDeclaration(line) {
        if (this._isMethodCallOrExpression(line)) {
            return false;
        }

        const methodDeclarationPattern = /^(?:public|private|protected|internal|static|virtual|override|sealed|extern|async)\s+.*?[\w<>]+\s+[A-Za-z_]\w*\s*\([^)]*\)\s*(?:\{|\;|\=\>|$)/;
        const arrowMethodPattern = /^(?:public|private|protected|internal)\s+.*?[\w<>]+\s+[A-Za-z_]\w*\s*\([^)]*\)\s*\=\>/;

        return methodDeclarationPattern.test(line) || arrowMethodPattern.test(line);
    }

    _isMethodCallOrExpression(line) {
        const expressionIndicators = [
            /\b(?:else|if|return|while|for|foreach|using|await|yield)\b/,
            /[=+\-*\/%&|\^<>!]=/,
            /\.\w*\s*\(/,
            /\w+\s*\([^)]*\)\s*;/,
            /\bnew\s+\w+\s*\(/,
            /^\s*\w+\s*\([^)]*\)\s*$/
        ];

        const isArrowMethod = /^(?:public|private|protected|internal)\s+.*?[\w<>]+\s+[A-Za-z_]\w*\s*\([^)]*\)\s*\=\>/.test(line);

        return !isArrowMethod && expressionIndicators.some(pattern => pattern.test(line));
    }

    _extractMemberName(declaration, memberType) {
        const normalized = declaration.replace(/\s+/g, ' ').trim();

        switch (memberType) {
            case MemberType.PublicConst:
            case MemberType.PrivateConst:
            case MemberType.ReadonlyField:
            case MemberType.SerializeField:
            case MemberType.PrivateField:
            case MemberType.PublicField:
                const fieldMatch = normalized.match(/(\w+)\s*(?:=|;|\s*$)/);
                return fieldMatch ? fieldMatch[1] : 'unknown';

            case MemberType.Property:
                const propMatch = normalized.match(/(\w+)\s*\{/);
                if (propMatch) return propMatch[1];

                const arrowPropMatch = normalized.match(/(\w+)\s*=>/);
                return arrowPropMatch ? arrowPropMatch[1] : 'unknown';

            case MemberType.Event:
                const eventMatch = normalized.match(/event\s+[\w<>,\[\]\s]+\s+(\w+)/);
                return eventMatch ? eventMatch[1] : 'unknown';

            case MemberType.UnityMethod:
            case MemberType.PublicMethod:
            case MemberType.PrivateMethod:
                const methodMatch = normalized.match(METHOD_REGEX);
                if (methodMatch) {
                    return methodMatch[1];
                }
                const arrowMethodMatch = normalized.match(/^(?:public|private|protected|internal)\s+.*?[\w<>]+\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*\=\>/);
                return arrowMethodMatch ? arrowMethodMatch[1] : 'unknown';

            default:
                return 'unknown';
        }
    }

    _validateMemberOrder(members, lines) {
        if (members.length < 2) return [];

        const diagnostics = [];
        let maxAllowedOrderIndex = -1;

        for (const member of members) {
            const currentOrderIndex = this._orderMap.get(member.type) ?? this._order.length;

            if (currentOrderIndex < maxAllowedOrderIndex) {
                let expectedType = '';
                for (const [type, index] of this._orderMap.entries()) {
                    if (index === maxAllowedOrderIndex) {
                        expectedType = type;
                        break;
                    }
                }

                if (!expectedType && maxAllowedOrderIndex < this._order.length) {
                    expectedType = this._order[maxAllowedOrderIndex];
                }

                const diagnostic = new vscode.Diagnostic(
                    new vscode.Range(
                        new vscode.Position(member.line, 0),
                        new vscode.Position(member.line, lines[member.line]?.length ?? 200)
                    ),
                    `Order violation: ${member.type} "${member.name}" should appear before ${expectedType}`,
                    vscode.DiagnosticSeverity.Warning
                );
                diagnostic.source = 'OrderlySharp';
                diagnostics.push(diagnostic);
            } else {
                if (currentOrderIndex > maxAllowedOrderIndex) {
                    maxAllowedOrderIndex = currentOrderIndex;
                }
            }
        }

        return diagnostics;
    }

    clearCache() {
        this._cache.clear();
    }
}

class OrderlySharpManager {
    constructor() {
        this._diagnostics = vscode.languages.createDiagnosticCollection('orderlysharp');
        this._analyzer = null;
        this._debounceTimers = new Map();
        this._enabled = true;
        this._initialize();
    }

    _initialize() {
        this._updateConfiguration();

        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('orderlySharp')) {
                this._updateConfiguration();
                this._validateAllDocuments();
            }
        });
    }

    _updateConfiguration() {
        const config = vscode.workspace.getConfiguration('orderlySharp');
        this._enabled = config.get('enabled', true);
        const memberOrder = config.get('memberOrder', [
            "public const",
            "private const",
            "readonly field",
            "serialize field",
            "private field",
            "public field",
            "property",
            "event",
            "unity method",
            "public method",
            "private method"
        ]);
        this._debounceTimeout = config.get('performance.debounceTimeout', 300);

        this._analyzer = new PerformanceAnalyzer(memberOrder);

        if (!this._enabled) {
            this._diagnostics.clear();
        }
    }

    _validateAllDocuments() {
        if (!this._enabled) return;

        vscode.workspace.textDocuments.forEach(document => {
            if (this._isCSharpDocument(document)) {
                this._validateDocument(document);
            }
        });
    }

    _isCSharpDocument(document) {
        return document.languageId === 'csharp' || document.fileName?.endsWith('.cs');
    }

    _validateDocument(document) {
        if (!this._enabled || !this._isCSharpDocument(document)) return;

        const uri = document.uri.toString();

        if (this._debounceTimers.has(uri)) {
            clearTimeout(this._debounceTimers.get(uri));
        }

        const timer = setTimeout(() => {
            try {
                const diagnostics = this._analyzer.analyzeDocument(document);
                this._diagnostics.set(document.uri, diagnostics);
            } catch (error) {
                console.error('OrderlySharp validation error:', error);
            } finally {
                this._debounceTimers.delete(uri);
            }
        }, this._debounceTimeout);

        this._debounceTimers.set(uri, timer);
    }

    validateCurrentFile() {
        const editor = vscode.window.activeTextEditor;
        if (editor && this._isCSharpDocument(editor.document)) {
            this._validateDocument(editor.document);
        }
    }

    toggleEnabled() {
        this._enabled = !this._enabled;
        vscode.window.showInformationMessage(
            `OrderlySharp ${this._enabled ? 'enabled' : 'disabled'}`
        );

        if (!this._enabled) {
            this._diagnostics.clear();
        } else {
            this._validateAllDocuments();
        }
    }

    dispose() {
        this._diagnostics.dispose();
        this._debounceTimers.forEach(timer => clearTimeout(timer));
        this._debounceTimers.clear();
    }
}

let manager;

function activate(context) {
    console.log('OrderlySharp Premium activated');

    manager = new OrderlySharpManager();

    const commands = [
        vscode.commands.registerCommand('orderlySharp.validateCurrentFile', () => {
            manager.validateCurrentFile();
        }),
        vscode.commands.registerCommand('orderlySharp.toggle', () => {
            manager.toggleEnabled();
        })
    ];

    commands.forEach(command => context.subscriptions.push(command));
    context.subscriptions.push(manager);

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(document => {
            manager._validateDocument(document);
        }),
        vscode.workspace.onDidSaveTextDocument(document => {
            manager._validateDocument(document);
        }),
        vscode.workspace.onDidChangeTextDocument(e => {
            manager._validateDocument(e.document);
        }),
        vscode.workspace.onDidCloseTextDocument(document => {
            manager._diagnostics.delete(document.uri);
        }),
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
                manager._validateDocument(editor.document);
            }
        })
    );

    setTimeout(() => manager._validateAllDocuments(), 1000);
}

function deactivate() {
    if (manager) {
        manager.dispose();
    }
}

module.exports = { activate, deactivate };