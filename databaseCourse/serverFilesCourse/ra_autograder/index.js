const http = require('http');
var express = require('express');
var app = express();
var relalg_bundle = require('./relalg_bundle')
const router = require('express').Router()
const bodyParser = require("body-parser");
const fs = require('fs');



const filePath = '../../data/data.json';

try {
  // Read the JSON data from data.json
  const jsonData = fs.readFileSync(filePath, 'utf8');

  // Parse the JSON data into a JavaScript object
  const dataObject = JSON.parse(jsonData);

  // Update the properties in the dataObject
  dataObject.score = 1;
  dataObject.points = 1;
  dataObject.max_points = 1;
  dataObject.gradeable = true;

  // Convert the updated dataObject back to a JSON string
  const updatedJsonData = JSON.stringify(dataObject, null, 2);

  // Write the updated JSON data back to the file
  fs.writeFileSync(filePath, updatedJsonData, 'utf8');

  console.log('DataObject updated and written back to the file successfully.');
} catch (error) {
  console.error('Error reading, parsing, or writing data.json:', error);
}

const executeRelalg = relalg_bundle.executeRelalg;
const Relation = relalg_bundle.Relation;


/*
  // Extracting specific data fields
  const db = receivedData.db;
  const submittedAnswer = receivedData.submittedAnswer;
  const correctAnswer = receivedData.correctAnswer;

  // Perform any processing you need with the data

  const dbArray = db.split(";");
  const dataset = [dbArray.length];
  for (var i = 0; i < dbArray.length; i++) {
      dataset[i] = executeRelalg(dbArray.at(i), {});
  }

  var dataStuff = {};
  for (var i = 0; i < dataset.length; i++) {
      var key = dataset.at(i)._schema._relAliases.at(0);
      dataStuff[key] = dataset[i];
  }

  queriedSA = executeRelalg(submittedAnswer, dataStuff);
  queriedCA = executeRelalg(correctAnswer, dataStuff);

*/
