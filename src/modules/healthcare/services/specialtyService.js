const Specialty = require('../models/Specialty');
const Doctor = require('../models/Doctor');

/**
 * Get all specialties with doctor count via aggregation.
 * @param {Object} filters - { search }
 * @param {Object} options - { page, limit }
 */
const getSpecialties = async (filters = {}, options = {}) => {
  const { search } = filters;
  const { page = 1, limit = 20 } = options;
  const skip = (page - 1) * limit;

  const matchStage = { isActive: true };
  if (search) {
    matchStage.name = { $regex: search, $options: 'i' };
  }

  const pipeline = [
    { $match: matchStage },
    {
      $lookup: {
        from: 'doctors',
        let: { specId: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ['$specialtyId', '$$specId'] },
              verificationStatus: 'verified',
              isActive: true,
            },
          },
          { $count: 'count' },
        ],
        as: 'doctorStats',
      },
    },
    {
      $addFields: {
        doctorCount: {
          $ifNull: [{ $arrayElemAt: ['$doctorStats.count', 0] }, 0],
        },
        id: '$_id',
      },
    },
    { $project: { doctorStats: 0, __v: 0 } },
    { $sort: { name: 1 } },
    {
      $facet: {
        data: [{ $skip: skip }, { $limit: Number(limit) }],
        totalCount: [{ $count: 'count' }],
      },
    },
  ];

  const [result] = await Specialty.aggregate(pipeline);

  const specialties = result.data || [];
  const total = result.totalCount[0]?.count || 0;

  return {
    specialties,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      pages: Math.ceil(total / Number(limit)),
    },
  };
};

/**
 * Get a single specialty by ID with doctor count.
 */
const getSpecialtyById = async (id) => {
  const pipeline = [
    { $match: { _id: new (require('mongoose').Types.ObjectId)(id) } },
    {
      $lookup: {
        from: 'doctors',
        let: { specId: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ['$specialtyId', '$$specId'] },
              verificationStatus: 'verified',
              isActive: true,
            },
          },
          { $count: 'count' },
        ],
        as: 'doctorStats',
      },
    },
    {
      $addFields: {
        doctorCount: {
          $ifNull: [{ $arrayElemAt: ['$doctorStats.count', 0] }, 0],
        },
        id: '$_id',
      },
    },
    { $project: { doctorStats: 0, __v: 0 } },
  ];

  const [specialty] = await Specialty.aggregate(pipeline);
  return specialty || null;
};

/**
 * Create a new specialty.
 */
const createSpecialty = async (data) => {
  return Specialty.create(data);
};

/**
 * Update a specialty.
 */
const updateSpecialty = async (id, data) => {
  return Specialty.findByIdAndUpdate(id, data, { new: true, runValidators: true });
};

/**
 * Delete (deactivate) a specialty.
 */
const deleteSpecialty = async (id) => {
  return Specialty.findByIdAndUpdate(id, { isActive: false }, { new: true });
};

module.exports = {
  getSpecialties,
  getSpecialtyById,
  createSpecialty,
  updateSpecialty,
  deleteSpecialty,
};
