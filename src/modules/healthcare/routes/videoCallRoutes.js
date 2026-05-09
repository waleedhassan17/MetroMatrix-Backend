const express = require('express');
const router = express.Router();
const {
    joinVideoCall,
    getCallStatus,
    endVideoCall
} = require('../controllers/videoCallController');
const { requireUser } = require('../middleware/healthcareAuth');

router.use(requireUser);

router.post('/join/:appointmentId', joinVideoCall);
router.get('/:callId/status', getCallStatus);
router.post('/:callId/end', endVideoCall);

module.exports = router;