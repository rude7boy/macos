export const parseMonetary = (val) => {
    if (val === null || val === undefined || val === '') return 0;
    if (typeof val === 'number') return val;

    const strVal = val.toString().trim();

    if (strVal.includes(',')) {
        const clean = strVal.replace(/[^\d,-]/g, '');
        return parseFloat(clean.replace(',', '.')) || 0;
    } else {
        const clean = strVal.replace(/[^\d.-]/g, '');
        return parseFloat(clean) || 0;
    }
};

export const normalizePhone = (p) => p ? String(p).replace(/\D/g, '') : '';
