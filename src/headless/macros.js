export function applyTextMacros(text, { charName = 'Assistant', userName = 'User', charIfNotGroup = charName, group = '', ...macros } = {}) {
    const environment = {
        ...macros,
        char: charName,
        user: userName,
        charIfNotGroup,
        group,
    };
    const lowerCaseEnvironment = Object.fromEntries(
        Object.entries(environment).map(([key, value]) => [key.toLowerCase(), value]),
    );

    return String(text ?? '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
        const value = lowerCaseEnvironment[String(key).toLowerCase()];
        return value === undefined || value === null ? match : String(value);
    });
}
