const { validationResult } = require('express-validator');

// Validation middleware
const validate = (req, res, next) => {
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    // express-validator v7 renamed `param` to `path`. This still read `param`,
    // so every entry serialised as {"undefined": "..."} — the field name was
    // lost and clients looking for `message` found nothing, leaving them with
    // a bare "Validation failed" and no way to see the real reason. Shape
    // matches handleValidationErrors in the healthcare modules.
    const details = errors.array().map((err) => ({
      field: err.path ?? err.type ?? null,
      message: err.msg,
    }));

    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      message: details.map((d) => d.message).join('; '),
      errors: details,
    });
  }
  
  next();
};

// Custom validators
const customValidators = {
  isPhoneNumber: (value) => {
    const phoneRegex = /^[0-9]{10,15}$/;
    return phoneRegex.test(value.replace(/[\s-]/g, ''));
  },
  
  isValidPassword: (value) => {
    // At least 6 characters, one uppercase, one lowercase, one number
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{6,}$/;
    return passwordRegex.test(value);
  },
  
  isValidCNIC: (value) => {
    // Pakistani CNIC format: 00000-0000000-0
    const cnicRegex = /^\d{5}-\d{7}-\d$/;
    return cnicRegex.test(value);
  },
  
  isValidDate: (value) => {
    const date = new Date(value);
    return date instanceof Date && !isNaN(date);
  },
  
  isAdult: (value) => {
    const birthDate = new Date(value);
    const today = new Date();
    const age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      return age - 1 >= 18;
    }
    
    return age >= 18;
  },
};

module.exports = {
  validate,
  customValidators,
};