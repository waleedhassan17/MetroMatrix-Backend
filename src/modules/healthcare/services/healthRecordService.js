const HealthRecord = require('../models/HealthRecord');

const getUserRecords = async (userId, filters = {}, options = {}) => {
  const query = { userId, ...filters };
  const { page = 1, limit = 10 } = options;
  return HealthRecord.find(query).sort({ date: -1 }).skip((page - 1) * limit).limit(limit);
};

const createRecord = async (data) => {
  return HealthRecord.create(data);
};

const updateRecord = async (id, userId, data) => {
  return HealthRecord.findOneAndUpdate({ _id: id, userId }, data, { new: true, runValidators: true });
};

const deleteRecord = async (id, userId) => {
  return HealthRecord.findOneAndDelete({ _id: id, userId });
};

module.exports = { getUserRecords, createRecord, updateRecord, deleteRecord };
