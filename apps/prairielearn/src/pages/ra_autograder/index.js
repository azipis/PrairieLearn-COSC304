// Import the executeRelalg() function from relalg_bundle.js
const { executeRelalg, Relation } = require('./relalg_bundle');

// Function to process the data and perform grading
async function processData(database, submittedAnswer, correctAnswer) {
  // Your custom grading logic goes here
  // Example: Compare the submitted answer with the correct answer and generate a result

  const dbArray = database.split(";");
  const dataset = [dbArray.length];
  for (var i = 0; i < dbArray.length; i++) {
      dataset[i] = executeRelalg(dbArray.at(i), {});
  }

  var dataStuff = {};
  for (var i = 0; i < dataset.length; i++) {
      var key = dataset.at(i)._schema._relAliases.at(0);
      dataStuff[key] = dataset[i];
  }

  var dataSA = {};
  var dataCA = {};

  try {
    var queriedSA = executeRelalg(submittedAnswer, dataStuff);

    dataSA = {
      schema: queriedSA.getResult()._schema,
      rows: queriedSA.getResult()._rows
    };

  } catch (error) {
    dataSA = {
      error: error.message
    }
  }

  try {
    var queriedCA = executeRelalg(correctAnswer, dataStuff);

    dataSA = {
      schema: queriedCA.getResult()._schema,
      rows: queriedCA.getResult()._rows
    };

  } catch (error) {
    dataCA = {
      error: error.message
    }
  }


  let gradeResult = {
    // Customize the result as needed
    // For example, you might have a more complex grading algorithm here
    // and calculate the grade based on the comparison of the submittedAnswer and correctAnswer.
    queriedSA: dataSA,
    queriedCA: dataCA
    // Add other grading-related data to the result object if needed
  };

  return gradeResult;
}

module.exports = {
  processData,
};