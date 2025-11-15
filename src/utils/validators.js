const mongoose = require('mongoose');

// Email validation
const isValidEmail = (email) => {
  const emailRegex = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/;
  return emailRegex.test(email);
};

// Phone number validation (Pakistan format)
const isValidPhoneNumber = (phoneNumber) => {
  const phoneRegex = /^[0-9]{10,15}$/;
  return phoneRegex.test(phoneNumber.replace(/[\s-]/g, ''));
};

// CNIC validation (Pakistani CNIC format: 00000-0000000-0)
const isValidCNIC = (cnic) => {
  const cnicRegex = /^\d{5}-\d{7}-\d$/;
  return cnicRegex.test(cnic);
};

// NIC validation (alternative format)
const isValidNIC = (nic) => {
  const nicRegex = /^\d{5}-\d{7}-\d$/;
  return nicRegex.test(nic);
};

// Password validation (min 6 characters, at least one uppercase, lowercase, number)
const isValidPassword = (password) => {
  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{6,}$/;
  return passwordRegex.test(password);
};

// Date validation
const isValidDate = (dateString) => {
  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date);
};

// Age validation (minimum age)
const isValidAge = (dateOfBirth, minimumAge = 18) => {
  const birthDate = new Date(dateOfBirth);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();

  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }

  return age >= minimumAge;
};

// MongoDB ID validation
const isValidMongoId = (id) => {
  return mongoose.Types.ObjectId.isValid(id);
};

// URL validation
const isValidURL = (url) => {
  try {
    new URL(url);
    return true;
  } catch (error) {
    return false;
  }
};

// File size validation
const isValidFileSize = (fileSizeInBytes, maxSizeInMB) => {
  const maxSizeInBytes = maxSizeInMB * 1024 * 1024;
  return fileSizeInBytes <= maxSizeInBytes;
};

// File type validation
const isValidFileType = (mimeType, allowedTypes) => {
  return allowedTypes.includes(mimeType);
};

// Image file validation
const isValidImageFile = (mimeType) => {
  const allowedImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  return isValidFileType(mimeType, allowedImageTypes);
};

// PDF file validation
const isValidPDFFile = (mimeType) => {
  return mimeType === 'application/pdf';
};

// Document file validation
const isValidDocumentFile = (mimeType) => {
  const allowedDocTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif'];
  return isValidFileType(mimeType, allowedDocTypes);
};

// Rating validation
const isValidRating = (rating) => {
  return Number.isInteger(rating) && rating >= 1 && rating <= 5;
};

// Array contains validation
const arrayContains = (array, value) => {
  return array.includes(value);
};

// Empty string check
const isEmpty = (value) => {
  return !value || value.trim().length === 0;
};

// Not empty check
const isNotEmpty = (value) => {
  return value && value.trim().length > 0;
};

// String length validation
const isValidLength = (value, minLength, maxLength) => {
  return value.length >= minLength && value.length <= maxLength;
};

// Special characters check
const hasSpecialCharacters = (value) => {
  const specialCharRegex = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/g;
  return specialCharRegex.test(value);
};

// Alphanumeric validation
const isAlphanumeric = (value) => {
  const alphanumericRegex = /^[a-zA-Z0-9]+$/;
  return alphanumericRegex.test(value);
};

// City name validation
const isValidCityName = (cityName) => {
  // Allow letters, spaces, and hyphens
  const cityRegex = /^[a-zA-Z\s'-]+$/;
  return cityRegex.test(cityName);
};

// Postal code validation (Pakistan format)
const isValidPostalCode = (postalCode) => {
  const postalRegex = /^\d{5}$/;
  return postalRegex.test(postalCode);
};

// Experience range validation
const isValidExperience = (experience) => {
  if (typeof experience === 'string') {
    // Check if it's a valid format like "5+ years" or "5-10 years"
    const expRegex = /^(\d+)\+? (year|month|week)(s)?$/i;
    return expRegex.test(experience);
  }
  return false;
};

// Professional name validation
const isValidProfessionalName = (name) => {
  // Allow letters, numbers, spaces, and common business characters
  const nameRegex = /^[a-zA-Z0-9\s\-&.,()]+$/;
  return nameRegex.test(name);
};

module.exports = {
  isValidEmail,
  isValidPhoneNumber,
  isValidCNIC,
  isValidNIC,
  isValidPassword,
  isValidDate,
  isValidAge,
  isValidMongoId,
  isValidURL,
  isValidFileSize,
  isValidFileType,
  isValidImageFile,
  isValidPDFFile,
  isValidDocumentFile,
  isValidRating,
  arrayContains,
  isEmpty,
  isNotEmpty,
  isValidLength,
  hasSpecialCharacters,
  isAlphanumeric,
  isValidCityName,
  isValidPostalCode,
  isValidExperience,
  isValidProfessionalName,
};